import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgTaskCompleteReconnect,
	cfgTaskCompleteReconnectDelay,
	cfgTaskCompleteReconnectMax,
} from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Unconfirmed-completion reconnect: a run that settles without a successful
 * `task_complete` marker is not confirmed finished. Provider-fault stops
 * (stream disconnects the wildtoken/ferrite gateways produce) and clean stops
 * that leave work outstanding (incomplete todos) must resubmit the turn at a
 * fixed interval instead of settling silently — the failure mode where a
 * flaky model sits idle with open todos until the user types to re-trigger it.
 *
 * Contracts these tests defend:
 * 1. A provider-error stop with unconfirmed work appends the reconnect reminder
 *    and reports the settle as non-terminal (`willContinue`), so the run stays
 *    alive without user input.
 * 2. A confirmed `task_complete` marker and a user interrupt stay terminal —
 *    the reconnect must never override the model's or the user's stop decision.
 * 3. A clean text stop with nothing outstanding stays terminal (no ping-pong
 *    on ordinary chat replies).
 * 4. A clean stop with incomplete todos reconnects (work unconfirmed).
 * 5. The dead-loop cap settles the run after `taskComplete.reconnectMax`
 *    reconnects without progress, and a successful tool result renews the budget.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession unconfirmed-completion reconnect", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let terminalEnds: boolean[];

	function usage() {
		return {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function assistantMessage(
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"],
		extra?: Partial<AssistantMessage>,
	): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason,
			usage: usage(),
			timestamp: Date.now(),
			...extra,
		};
	}

	function emitStop(message: AssistantMessage): void {
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	}

	function emitTextStop(text: string, extra?: Partial<AssistantMessage>): void {
		emitStop(assistantMessage([{ type: "text", text }], "stop", extra));
	}

	function emitErrorStop(errorMessage: string, errorId?: number): void {
		emitStop(
			assistantMessage([{ type: "text", text: "working through the list" }], "error", {
				errorMessage,
				errorId,
				errorStatus: errorId === undefined ? 502 : undefined,
			}),
		);
	}

	function emitAbortedStop(errorMessage: string, errorId: number): void {
		emitStop(
			assistantMessage([{ type: "text", text: "in the middle of a step" }], "aborted", {
				errorMessage,
				errorId,
			}),
		);
	}

	function emitMarkerTurn(): void {
		const toolCallId = `call_task_complete_${Date.now()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: "task_complete", arguments: {} };
		const markerTurn = assistantMessage(
			[{ type: "text", text: "All steps are done and verified." }, toolCall],
			"toolUse",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: markerTurn });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "task_complete",
				content,
				isError: false,
				timestamp: Date.now(),
			},
		});
	}

	function emitSuccessfulToolResult(toolName: string): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: {} };
		session.agent.emitExternalEvent({
			type: "message_end",
			message: assistantMessage([toolCall], "toolUse"),
		});
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: false,
				timestamp: Date.now(),
			},
		});
	}

	function reconnectReminders(): string[] {
		const texts: string[] = [];
		for (const message of session.agent.state.messages) {
			if (message.role !== "developer" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "text" && block.text.includes("(Reconnect")) texts.push(block.text);
			}
		}
		return texts;
	}

	function setIncompleteTodos(): void {
		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "in_progress" },
				],
			},
		]);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-unconfirmed-reconnect-");
		sessionManager = SessionManager.inMemory(tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders": false,
				// Isolate the reconnect gate from the request-level retry saga:
				// provider errors must fall through to the settle tail untouched.
				"retry.enabled": false,
				// Keep unexpected-stop classification off the critical path: a
				// thinking-only stop is not what these tests defend.
				"features.unexpectedStopDetection": "mechanical",
			}),
			modelRegistry: sharedModelRegistry,
		});
		terminalEnds = [];
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") terminalEnds.push(event.isTerminal === true);
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("reconnects a provider-error stop with unconfirmed work and keeps the run alive", async () => {
		setIncompleteTodos();
		emitErrorStop("OpenAI completions stream closed before a finish_reason was received", 135168);
		await session.waitForIdle();

		const reminders = reconnectReminders();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("(Reconnect 1/20)");
		expect(reminders[0]).toContain("Unfinished todo work remains");
		expect(reminders[0]).toContain("Slice 81");
		// The settle is non-terminal: the interval reconnect owns the next turn.
		expect(terminalEnds).toEqual([false]);
	});

	it("reconnects a clean text stop that leaves incomplete todos unconfirmed", async () => {
		setIncompleteTodos();
		emitTextStop("I have processed the tool results.");
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(1);
		expect(terminalEnds).toEqual([false]);
	});

	it("keeps a clean text stop terminal when nothing is outstanding", async () => {
		emitTextStop("Done — the question is answered, nothing left to do.");
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(0);
		expect(terminalEnds).toEqual([true]);
	});

	it("keeps a confirmed task_complete marker terminal", async () => {
		setIncompleteTodos();
		emitMarkerTurn();
		// The model confirmed completion with the marker; the following report
		// stop must settle even though the todo list still has stale items.
		emitTextStop("All steps are done and verified.");
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(0);
		expect(terminalEnds).toEqual([true]);
	});

	it("keeps a user interrupt terminal even with incomplete todos", async () => {
		setIncompleteTodos();
		emitAbortedStop("Interrupted by user", AIError.create(AIError.Flag.UserInterrupt));
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(0);
		expect(terminalEnds).toEqual([true]);
	});

	it("settles after the reconnect cap and renews the budget on tool progress", async () => {
		cfgTaskCompleteReconnectMax.override(session.settings, 1);
		setIncompleteTodos();

		emitErrorStop("502 upstream status 405: Blocked clients", 135168);
		await session.waitForIdle();
		expect(reconnectReminders()).toHaveLength(1);

		// No progress in between: the second unconfirmed stop trips the cap.
		emitErrorStop("502 upstream status 405: Blocked clients", 135168);
		await session.waitForIdle();
		expect(reconnectReminders()).toHaveLength(1);
		expect(terminalEnds).toEqual([false, true]);

		// A successful tool result renews the dead-loop budget.
		emitSuccessfulToolResult("bash");
		emitErrorStop("502 upstream status 405: Blocked clients", 135168);
		await session.waitForIdle();
		expect(reconnectReminders()).toHaveLength(2);
	});

	it("stays terminal when the reconnect feature is disabled", async () => {
		cfgTaskCompleteReconnect.override(session.settings, false);
		setIncompleteTodos();
		emitErrorStop("OpenAI completions stream closed before a finish_reason was received", 135168);
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(0);
		expect(terminalEnds).toEqual([true]);
	});

	it("keeps a compaction-owned 413 rejection terminal even with open todos", async () => {
		setIncompleteTodos();
		// 413 payload rejection is owned by #checkCompaction; resubmitting the same
		// oversized request can never succeed, so it must not be retried by resubmission.
		emitStop(
			assistantMessage([{ type: "text", text: "context window exceeded" }], "error", {
				errorMessage: "413 Request Entity Too Large: input exceeds the limit of 262144 tokens",
				errorStatus: 413,
			}),
		);
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(0);
		expect(terminalEnds).toEqual([true]);
	});

	it("does not hold waitForIdle for the reconnect interval", async () => {
		cfgTaskCompleteReconnectDelay.override(session.settings, 120_000);
		setIncompleteTodos();
		emitErrorStop("502 upstream status 405: Blocked clients", 135168);
		// The parked interval must not be tracked post-prompt work: the session
		// settles immediately even though the reconnect is 2 minutes out.
		await session.waitForIdle();

		expect(reconnectReminders()).toHaveLength(1);
		expect(terminalEnds).toEqual([false]);
	});
});
