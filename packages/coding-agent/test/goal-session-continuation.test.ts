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

	/** Drives the real event chain: todo init toolCall + successful toolResult. */
	function emitTodoInit(
		phases: Array<Record<string, unknown>> = [{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] }],
	): void {
		const toolCallId = "call_todo_link";
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "todo", arguments: { op: "init" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
		});
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { op: "init", phases },
				timestamp: Date.now(),
			},
		});
	}

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

	it("reconnects through provider outages and auto-pauses only after 11 consecutive same-code errors", async () => {
		session.settings.set("retry.enabled", false);
		await session.goalRuntime.createGoal({ objective: "Ship the release" });

		let providerCall = 0;
		session.agent.streamFn = () => {
			providerCall++;
			const message = {
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
				errorStatus: 502,
				errorMessage: "502 JSON error injected into SSE stream",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};

		/** 等待下一次 goal 自动暂停(goal_updated 事件,无定时器猜测)。 */
		const waitForNextPause = (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			const off = session.subscribe(event => {
				if (event.type === "goal_updated" && event.goal.status === "paused") {
					off();
					resolve();
				}
			});
			return promise;
		};

		// 故障期间会话不停摆:用户 prompt 失败后自动重连续跑,直到同一 502
		const pausedFirst = waitForNextPause();
		await session.prompt("start the work");
		await pausedFirst;
		// 暂停事件先于 agent unwind 完成:等 unwind 结束后再断言/继续,
		// 避免下一个 prompt 撞上 AgentBusyError(与 TUI 800ms 延时同一竞态)。
		await session.waitForIdle();
		expect(providerCall).toBe(11);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");

		// 用户重发 prompt:agent_start 自动 resume,重连循环重新开始(计数清零),
		const pausedSecond = waitForNextPause();
		await session.prompt("retry");
		await pausedSecond;
		await session.waitForIdle();
		expect(providerCall).toBe(22);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("stops reconnecting immediately on an auth failure (401)", async () => {
		session.settings.set("retry.enabled", false);
		await session.goalRuntime.createGoal({ objective: "Ship the release" });

		let providerCall = 0;
		session.agent.streamFn = () => {
			providerCall++;
			const message = {
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
				errorStatus: 401,
				errorMessage: "Invalid API key",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};

		// key 失效:重连无意义,第一次 401 即暂停。
		await session.prompt("start the work");
		await session.waitForIdle();
		expect(providerCall).toBe(1);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
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

	it("aborts a non-goal long streaming turn before any follow-up provider call (AC-1)", async () => {
		session.settings.set("todo.enabled", false);

		let providerCall = 0;
		const firstRelease = Promise.withResolvers<void>();
		const streamBegan = Promise.withResolvers<void>();
		session.agent.streamFn = () => {
			const n = providerCall++;
			if (n === 0) streamBegan.resolve();
			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: `stream ${n}` }],
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
				stopReason: "length" as const,
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (n === 0) firstRelease.promise.then(() => stream.push({ type: "done", reason: "length", message }));
				else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const running = session.prompt("start the work");
		await streamBegan.promise;
		const aborting = session.abort();
		await aborting;
		await session.waitForIdle();

		// AC-1: 非 goal 长流转下 ESC 一次确实停下:provider 只被叫过一次,stream 停住。
		expect(providerCall).toBe(1);
		expect(session.isStreaming).toBe(false);
		firstRelease.resolve();
		await running.catch(() => {});
	});

	it("auto-resumes a paused goal when the user submits a new prompt", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await session.goalRuntime.pauseGoal();
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		mockTextStop("resuming");

		// 停止 → 运行:用户源 turn 自动把 paused goal 恢复 active。
		await session.prompt("keep going");
		await session.waitForIdle();

		const state = session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.status).toBe("active");
	});

	it("does not auto-resume a paused goal on a system-origin (custom) turn", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await session.goalRuntime.pauseGoal();
		mockTextStop("reminder ack");

		// 系统源 turn(todo reminder / 隐藏消息)不得把 paused goal 拉回 active。
		await session.promptCustomMessage({
			customType: "todo-reminder",
			content: [{ type: "text", text: "reminder" }],
			display: false,
		});
		await session.waitForIdle();

		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("creates a goal linked to a freshly initialised todo list", async () => {
		expect(session.getGoalModeState()).toBeUndefined();
		mockTextStop("done");

		// 驱动真实事件链:todo init 的 toolResult 必须挂出联动 goal。
		emitTodoInit([
			{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] },
			{ name: "Verify", tasks: [{ content: "tests", status: "pending" }] },
		]);
		await session.waitForIdle();

		const state = session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.objective).toBe("Complete todo list: Build, Verify");
	});

	it("does not clobber an existing goal when a todo list is initialised", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		mockTextStop("done");

		emitTodoInit();

		const state = session.getGoalModeState();
		expect(state?.goal.objective).toBe("Ship the release");
	});

	it("auto-completes the todo-linked goal when every task completes", async () => {
		mockTextStop("done");
		emitTodoInit();
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.status).toBe("active");

		// 生产链路里 todo 工具成功后调用的正是这个入口(tools/todo.ts)。
		session.setTodoPhases([
			{ name: "Build", tasks: [{ content: "scaffold", status: "completed" }] },
			{ name: "Verify", tasks: [{ content: "tests", status: "completed" }] },
		]);
		await session.waitForIdle();

		const state = session.getGoalModeState();
		expect(state?.goal.status).toBe("complete");
	});

	it("leaves a user goal untouched when the todo list completes", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		mockTextStop("done");

		session.setTodoPhases([{ name: "Build", tasks: [{ content: "scaffold", status: "completed" }] }]);

		const state = session.getGoalModeState();
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.objective).toBe("Ship the release");
	});

	it("drops the todo-linked goal when the user clears the todo list", async () => {
		mockTextStop("done");
		emitTodoInit();
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.status).toBe("active");

		// /todo clear 语义:清单没了主体就没了,goal 应 drop 而不是继续驱动续跑。
		session.setTodoPhases([]);
		await session.waitForIdle();

		expect(session.getGoalModeState()).toBeUndefined();
	});

	it("leaves a user goal untouched when the todo list is cleared", async () => {
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		mockTextStop("done");

		session.setTodoPhases([]);

		const state = session.getGoalModeState();
		expect(state?.goal.objective).toBe("Ship the release");
	});

	it("does not drop or complete the abandoned goal on /new", async () => {
		mockTextStop("done");
		emitTodoInit();
		await session.waitForIdle();
		const oldFile = session.sessionManager.getSessionFile();
		if (!oldFile) throw new Error("expected session file");
		const modes = async (): Promise<string[]> =>
			(await Bun.file(oldFile).text())
				.split("\n")
				.filter(line => line.includes('"mode_change"'))
				.map(line => String(JSON.parse(line).mode));
		const before = await modes();

		await session.newSession();

		// /new 后新会话无 goal。旧 journal 只允许既有 abort 路径的 "goal_paused";
		// 空清单路径不得追加 drop("none")或 complete(第二条 "goal")。
		expect(session.getGoalModeState()).toBeUndefined();
		const after = await modes();
		expect(after).not.toContain("none");
		expect(after.filter(mode => mode === "goal").length).toBe(before.filter(mode => mode === "goal").length);
	});
});
