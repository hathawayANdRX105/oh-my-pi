import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Task completion guard: while the `task_complete` marker tool is active, a
 * text-only stop without the marker is not terminal — the session nudges and
 * continues (capped); the marker (or the cap) ends the run. Provider-error
 * recovery stays on the goal-continuation machinery and is unaffected.
 */
describe("task completion guard", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let toolSession: ToolSession;
	let providerCall = 0;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-task-complete-guard-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": false,
			"todo.enabled": false,
		});
		providerCall = 0;
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 in registry");

		const bootstrapToolSession = { cwd: tempDir.path(), settings } as unknown as ToolSession;
		const initialTools = await createTools(bootstrapToolSession, ["read", "task_complete"]);
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
	});

	afterEach(async () => {
		await session.dispose();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	/** Assistant response: bare text stop, or a task_complete toolCall turn. */
	function armStream(
		respond: (callIndex: number) => {
			text?: string;
			marker?: boolean;
			stopReason?: "stop" | "toolUse";
		},
	): void {
		session.agent.streamFn = () => {
			const n = providerCall++;
			const spec = respond(n);
			const message = {
				role: "assistant" as const,
				content: spec.marker
					? [{ type: "toolCall" as const, id: `call_marker_${n}`, name: "task_complete", arguments: {} }]
					: [{ type: "text" as const, text: spec.text ?? `bare stop ${n}` }],
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
				stopReason: spec.marker ? ("toolUse" as const) : (spec.stopReason ?? ("stop" as const)),
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

	const nudgeCount = () =>
		session.agent.state.messages.filter(
			message => message.role === "developer" && JSON.stringify(message.content).includes("task_complete"),
		).length;

	it("nudges bare stops and caps at three continuations", async () => {
		armStream(() => ({ text: "still working" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// bare stop 0 → nudge → call 1; nudge → call 2; nudge → call 3; cap → terminal.
		expect(providerCall).toBe(4);
		expect(nudgeCount()).toBe(3);
	});
	it("terminates the run when the model calls task_complete", async () => {
		// 真实模型行为:标记一次,随后以文本收束(不再重复调标记)。
		armStream(n => (n === 0 ? { text: "working" } : n === 1 ? { marker: true } : { text: "all done" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// n=0 bare stop → one nudge; n=1 marker turn (tool executes); n=2 text
		// stop settles marked → terminal without further continuations.
		expect(providerCall).toBe(3);
		expect(nudgeCount()).toBe(1);
	});

	it("stays silent when the guard is disabled", async () => {
		session.settings.set("taskComplete.enabled", false);
		armStream(() => ({ text: "done talking" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		expect(providerCall).toBe(1);
		expect(nudgeCount()).toBe(0);
	});

	it("hands normal-stop continuation to the guard, not the goal driver, when both are active", async () => {
		session.settings.set("goal.enabled", true);
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		armStream(() => ({ text: "working" }));
		const promptSpy = vi.spyOn(session, "promptCustomMessage");

		await session.prompt("do the work");
		await session.waitForIdle();

		// Guard owns the bare-stop continuation: no goal-continuation submission,
		// capped guard nudges instead.
		expect(promptSpy.mock.calls.filter(call => call[0]?.customType === "goal-continuation")).toHaveLength(0);
		expect(nudgeCount()).toBe(3);
		expect(providerCall).toBe(4);
	});
});
