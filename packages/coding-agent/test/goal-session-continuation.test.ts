import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Session-layer goal continuation smoke: with an active goal, a settled turn
 * must be immediately followed by a hidden `goal-continuation` prompt turn —
 * without any TUI involvement. This is the all-run-modes guarantee.
 */
describe("session-layer goal continuation", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let toolSession: ToolSession;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-session-continuation-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": true,
			"todo.enabled": true,
		});
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 in registry");

		const bootstrapToolSession = {
			cwd: tempDir.path(),
			settings,
		} as unknown as ToolSession;
		const initialTools = await createTools(bootstrapToolSession, ["read"]);
		const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
		toolSession = bootstrapToolSession;

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: initialTools, messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);
		session.setActiveToolsByName(["read", "goal"]);
	});

	afterEach(async () => {
		await session.dispose();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	function mockTextStop(text: string): void {
		let providerCall = 0;
		session.agent.streamFn = () => {
			const n = providerCall++;
			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: n === 0 ? text : `continuation turn ${n}` }],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		};
	}

	it("continues autonomously after a settled turn when a goal is active", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		mockTextStop("working on it");

		const promptSpy = vi.spyOn(session, "promptCustomMessage");

		await session.prompt("start the work");
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalled();
		const submission = promptSpy.mock.calls[0]?.[0];
		expect(submission?.customType).toBe("goal-continuation");
		expect(submission?.display).toBe(false);
		expect(submission?.content).toContain("Ship the release");
	});

	it("does not continue when no goal is active", async () => {
		mockTextStop("plain answer");
		const promptSpy = vi.spyOn(session, "promptCustomMessage");

		await session.prompt("just a question");
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("continues after an error-settled turn when a goal is active (no silent chain break)", async () => {
		session.settings.set("retry.enabled", false);
		await session.goalRuntime.createGoal({ objective: "Ship the release" });

		let providerCall = 0;
		session.agent.streamFn = () => {
			const n = providerCall++;
			const message =
				n === 0
					? {
							role: "assistant" as const,
							content: [],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "error" as const,
							errorMessage: "stream closed before a finish_reason",
							timestamp: Date.now(),
						}
					: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: `recovered turn ${n}` }],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop" as const,
							timestamp: Date.now(),
						};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		const promptSpy = vi.spyOn(session, "promptCustomMessage");
		await session.prompt("start the work");
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalled();
		expect(promptSpy.mock.calls[0]?.[0]?.content).toContain("Ship the release");
		// The continuation turn actually ran against the provider.
		expect(providerCall).toBeGreaterThanOrEqual(2);
	});

	it("todo reminder resumes work after an error-settled turn when todo.resumeAfterError is on", async () => {
		session.settings.set("retry.enabled", false);
		session.settings.set("todo.resumeAfterError", true);
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish the report", status: "pending" }] }]);

		let providerCall = 0;
		session.agent.streamFn = () => {
			const n = providerCall++;
			const message = {
				role: "assistant" as const,
				content: [
					n === 0
						? { type: "text" as const, text: "attempting" }
						: { type: "text" as const, text: "resumed work" },
				],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: n === 0 ? ("error" as const) : ("stop" as const),
				errorMessage: n === 0 ? "boom" : undefined,
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await session.prompt("start the work");
		await session.waitForIdle();

		// The todo reminder scheduled a continuation: the provider saw a second turn.
		expect(providerCall).toBeGreaterThanOrEqual(2);
	});

	it("todo reminder stays silent after an error-settled turn when todo.resumeAfterError is off", async () => {
		session.settings.set("retry.enabled", false);
		session.settings.set("todo.resumeAfterError", false);
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish the report", status: "pending" }] }]);

		let providerCall = 0;
		session.agent.streamFn = () => {
			providerCall++;
			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "attempting" }],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error" as const,
				errorMessage: "boom",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error" as const, error: message });
			});
			return stream;
		};

		await session.prompt("start the work");
		await session.waitForIdle();

		// Negative contract: the error settles the run; no reminder turn follows.
		expect(providerCall).toBe(1);
	});

	it("pauses the goal when the user aborts with ESC (abort stop)", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		mockTextStop("working on it");

		await session.prompt("start the work");
		session.abort();
		await session.waitForIdle();

		// ESC = 暂停:goal 转 paused,且不再自动续跑。
		const state = session.getGoalModeState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(session.isStreaming).toBe(false);
	});
});
