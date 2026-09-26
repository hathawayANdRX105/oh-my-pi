import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression coverage for issue #2590: `#checkTodoCompletion` used to schedule
 * `agent.continue()` after appending its `<system-reminder>`, so any text-only
 * acknowledgement from the agent ("paused at your instruction") triggered another
 * `agent_end`, which incremented the counter and fired the next reminder — no
 * user input required. Within a single user pause that loop runs 1/3 → 2/3 → 3/3.
 *
 * The contract these tests defend: a reminder MUST NOT escalate inside a
 * self-continuation chain unless the agent has produced a tool-level result
 * (e.g. called `todo` or `edit`) between the prior reminder and the next stop.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession todo reminder self-continuation suppression", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let reminderAttempts: number[];

	function textOnlyAssistantMessage(text = "paused at your instruction"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(text?: string): void {
		const msg = textOnlyAssistantMessage(text);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitToolResult(
		toolName: string,
		details: Record<string, unknown> = {},
		options?: { isError?: boolean },
	): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: {} };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: options?.isError ?? false,
				details,
				timestamp: Date.now(),
			},
		});
	}

	function todoReminderTranscriptEntry() {
		return sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent =>
					item.type === "text" && item.text.includes("You stopped with 2 incomplete todo item(s):"),
			);
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-reminder-loop-");
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
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry: sharedModelRegistry,
		});

		reminderAttempts = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
		});

		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("baseline: a single text-only stop fires reminder 1/3 and records it in the transcript", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([1]);

		const reminderEntry = todoReminderTranscriptEntry();
		expect(reminderEntry?.type).toBe("message");
	});

	it("does not remind or continue when the assistant yields with a user-facing question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("I need your feedback before continuing. Which trade-off should I optimize for?");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not remind or continue when the assistant yields with a non-English (Chinese) question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("我遇到一个需要你决定的问题：是否应该继续删除旧的配置文件？");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("still reminds when the assistant answers its own prompt-shaped question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop(
			"Which configuration should this use?\nUse the existing default; the remaining todo items still need work.",
		);
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("still reminds and continues when ordinary prose contains answer", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Final answer: I summarized the work completed so far, but the todo items remain open.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("still reminds and continues when TypeScript optional syntax appears in the assistant tail", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Tail note: the interface includes foo?: string, but the todo items remain open.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("escalates through the reminder cap when the agent only acknowledges", async () => {
		// Each call to continue() mirrors what the bug-reported model did: emit another
		// text-only stop ("paused at your instruction"), no tool calls in between.
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		// 无进度抑制:纯 ack 停止照常升级 1/3 -> 2/3 -> 3/3,cap 后链条终止。
		expect(reminderAttempts).toEqual([1, 2, 3]);
	});

	it("re-escalates after the agent makes tool-level progress between stops", async () => {
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount === 1) {
				// In response to reminder 1/3 the agent actually did work (called `todo`),
				// then stopped again with todos still incomplete.
				emitToolResult("todo", { op: "start", phases: session.getTodoPhases() });
				emitTextOnlyStop();
				return;
			}
			// Subsequent continuations are bare acks — they escalate to the cap.
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		// 1/3 fires, agent does work (progress refreshes the budget), 1/3 fires again,
		// bare acks then escalate 2/3 -> 3/3; the chain ends at the cap.
		expect(reminderAttempts).toEqual([1, 1, 2, 3]);
	});

	it("keeps a fresh reminder budget while the agent makes progress (runs past the cap)", async () => {
		// remindersMax is 3. The old total-per-prompt budget ended the chain at the
		// 3rd reminder even for a progressing task; with progress-reset the budget
		// only bounds consecutive no-progress chains, so a working agent keeps a
		// fresh 1/3 on every stop and the chain runs to completion.
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount <= 4) {
				emitToolResult("todo", { op: "start", phases: session.getTodoPhases() });
			}
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		// Five fresh attempts (progress reset the counter each time) instead of the
		// old capped [1, 2, 3]; the trailing bare acks escalate 2/3 -> 3/3 to the cap.
		expect(reminderAttempts).toEqual([1, 1, 1, 1, 1, 2, 3]);
	});

	it("keeps the cap when only read-only tools progress (no budget refresh)", async () => {
		// Read-only results (read/grep/...) are NOT progress: the budget refresh
		// is limited to todo/mutating results so a read/stop loop still hits the
		// remindersMax cap instead of running unbounded.
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount <= 3) emitToolResult("read");
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		// No refresh: 1/3 -> 2/3 -> 3/3, then the cap suppresses the fourth.
		expect(reminderAttempts).toEqual([1, 2, 3]);
	});

	it("keeps the cap across repeated read-only todo views", async () => {
		// `todo view` is a pure read (TodoTool returns the phases without writing
		// state), so it must not refresh the budget: a view/stop loop still hits
		// the cap instead of running unbounded.
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount <= 3) {
				emitToolResult("todo", { op: "view", phases: session.getTodoPhases() });
			}
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1, 2, 3]);
	});

	it("keeps the cap across repeated failed todo calls", async () => {
		// A rejected todo payload commits nothing (TodoTool discards the whole
		// batch on error), so failures are not progress and must not refresh the
		// budget — otherwise an agent that keeps fixing an invalid payload loops
		// forever under a permanently reset counter.
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount <= 3) {
				emitToolResult("todo", { op: "done", phases: session.getTodoPhases() }, { isError: true });
			}
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1, 2, 3]);
	});
});
