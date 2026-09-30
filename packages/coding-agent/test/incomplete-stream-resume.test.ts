import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const PREMATURE_COMPLETIONS_CLOSE = "OpenAI completions stream closed before a finish_reason was received";

function makePartialAssistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeErrorAssistant(partial: AssistantMessage, errorMessage: string, errorId: number): AssistantMessage {
	return {
		...partial,
		content: partial.content.map(block => ({ ...block })),
		stopReason: "error",
		errorMessage,
		errorId,
	};
}

describe("incomplete-stream auto-resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-incomplete-stream-resume-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(async () => {
		await session.dispose();
		tempDir.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	function startSession(): { providerCalls: number } {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
		});
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 in registry");
		const calls = { providerCalls: 0 };
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		session.agent.streamFn = () => {
			const n = calls.providerCalls++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (n === 0) {
					const partial = makePartialAssistantText("part of the answer");
					stream.push({ type: "start", partial });
					stream.push({
						type: "error",
						reason: "error",
						error: makeErrorAssistant(
							partial,
							PREMATURE_COMPLETIONS_CLOSE,
							AIError.create(AIError.Flag.Transient),
						),
					});
				} else {
					const message = makePartialAssistantText("continued response");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};
		return calls;
	}

	it("auto-resumes when a provider stream dies mid-response on a text-only turn", async () => {
		const calls = startSession();
		mockSchedulerWaitWithClock();
		await session.prompt("finish the answer");
		await session.waitForIdle();

		// First call dies mid-response with an incomplete-stream error; the
		// session must schedule a second provider call instead of stopping.
		expect(calls.providerCalls).toBe(2);

		// Hidden resume notice is appended to the session journal so the
		// continued turn is replayed with an explicit-handoff marker.
		const journalHasResumeNotice = session.sessionManager
			.getEntries()
			.some(entry => entry.type === "custom_message" && entry.customType === "incomplete-stream-resume");
		expect(journalHasResumeNotice).toBe(true);

		// And the preserved partial stays in context — the continuation was not replayed.
		const lastAssistant = session.agent.state.messages.at(-1);
		expect(lastAssistant?.role).toBe("assistant");
	});

	it("does not auto-resume when the same message carries a non-retriable error classification", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
		});
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 in registry");
		let providerCalls = 0;
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		session.agent.streamFn = () => {
			providerCalls++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = makePartialAssistantText("part of the answer");
				stream.push({
					type: "error",
					reason: "error",
					error: makeErrorAssistant(
						partial,
						// Non-retriable flag overrides the otherwise-transient text match.
						PREMATURE_COMPLETIONS_CLOSE,
						AIError.create(AIError.Flag.ContentBlocked),
					),
				});
			});
			return stream;
		};
		mockSchedulerWaitWithClock();

		await session.prompt("finish the answer");
		await session.waitForIdle();

		expect(providerCalls).toBe(1);
	});
});
