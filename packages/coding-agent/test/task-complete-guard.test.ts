import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgTaskCompleteEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, TaskCompleteTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Task completion guard: while the `task_complete` marker tool is active, a
 * text-only stop without the marker is not terminal — the session nudges and
 * continues (capped); the marker (or the cap) ends the run. The marker is a stop
 * *signal*, not a delivery channel: it ends the run at its tool result only when
 * the marker turn also carried user-facing text. A silent marker keeps the run
 * alive so the model still gets its report turn, capped against a degenerate
 * marker-only loop. Provider-error recovery stays on the goal-continuation
 * machinery and is unaffected.
 */
describe("task completion guard", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let notePath: string;
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
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 in registry");

		const bootstrapToolSession = { cwd: tempDir.path(), settings } as unknown as ToolSession;
		const initialTools = await createTools(bootstrapToolSession, ["read", "task_complete"]);
		const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

		notePath = tempDir.join("note.txt");
		await Bun.write(notePath, "sibling payload");
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

	/** Assistant response: bare text stop, a marker, a marker batched with a sibling call, or a marker alongside text. */
	function armStream(
		respond: (callIndex: number) => {
			text?: string;
			marker?: boolean;
			markerWithText?: boolean;
			batchedMarker?: boolean;
			stopReason?: "stop" | "toolUse";
		},
	): void {
		session.agent.streamFn = () => {
			const n = providerCall++;
			const spec = respond(n);
			const markerCall = {
				type: "toolCall" as const,
				id: `call_marker_${n}`,
				name: "task_complete",
				arguments: {},
			};
			const textBlock = { type: "text" as const, text: spec.text ?? `bare stop ${n}` };
			const content = spec.batchedMarker
				? [
						{
							type: "toolCall" as const,
							id: `call_sibling_${n}`,
							name: "read",
							arguments: { path: notePath },
						},
						markerCall,
					]
				: spec.markerWithText
					? [textBlock, markerCall]
					: spec.marker
						? [markerCall]
						: [textBlock];
			const message = {
				role: "assistant" as const,
				content,
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
				stopReason:
					spec.marker || spec.batchedMarker || spec.markerWithText
						? ("toolUse" as const)
						: (spec.stopReason ?? ("stop" as const)),
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
	it("ends the run at a text-bearing marker, without buying a follow-up turn", async () => {
		// The model states its result and closes with the marker in one turn; the
		// loop must not spend another provider call asking it to restate that.
		armStream(n =>
			n === 0 ? { text: "working" } : n === 1 ? { markerWithText: true, text: "all done" } : { text: "unreachable" },
		);

		await session.prompt("do the work");
		await session.waitForIdle();

		// n=0 bare stop → one nudge; n=1 text + marker ends the run at the tool
		// result, so the trailing text turn never happens.
		expect(providerCall).toBe(2);
		expect(nudgeCount()).toBe(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "assistant" && JSON.stringify(message.content).includes("unreachable"),
			),
		).toBe(false);
		expect(
			session.agent.state.messages.some(
				message => message.role === "toolResult" && message.toolName === "task_complete" && !message.isError,
			),
		).toBe(true);
	});

	it("keeps the run alive after a silent marker so the model still reports", async () => {
		// A marker with no text used to end the run at the tool result, leaving the
		// user with a marker chip and no report. The run must continue instead: the
		// model gets its report turn, and the marked flag settles that stop.
		armStream(n => (n === 0 ? { text: "working" } : n === 1 ? { marker: true } : { text: "all done" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// n=0 bare stop → nudge; n=1 silent marker keeps the loop alive; n=2 delivers
		// the report and settles without another nudge.
		expect(providerCall).toBe(3);
		expect(nudgeCount()).toBe(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "assistant" && JSON.stringify(message.content).includes("all done"),
			),
		).toBe(true);
	});

	it("caps a model that only ever fires the marker without reporting", async () => {
		// Degenerate loop guard: silent markers normally get one report turn. A model
		// that never writes text must not spin forever.
		armStream(() => ({ marker: true }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// Two silent markers exhaust the budget; the run ends there.
		expect(providerCall).toBe(2);
	});

	it("keeps running when the marker is batched with a sibling call", async () => {
		// A batched marker is not terminal: the terminal abort would skip the
		// not-yet-started sibling and drop its result, so the run continues and
		// settles on the next stop.
		armStream(n => (n === 0 ? { text: "working" } : n === 1 ? { batchedMarker: true } : { text: "all done" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// n=0 bare stop → one nudge; n=1 batched marker keeps the loop alive and
		// still delivers the sibling result; n=2 settles on the marked stop.
		expect(providerCall).toBe(3);
		expect(
			session.agent.state.messages.some(message => message.role === "toolResult" && message.toolName === "read"),
		).toBe(true);
	});

	it("stays silent when the guard is disabled", async () => {
		cfgTaskCompleteEnabled.set(session.settings, false);
		armStream(() => ({ text: "done talking" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		expect(providerCall).toBe(1);
		expect(nudgeCount()).toBe(0);
	});

	it("stands down when an active goal owns continuation", async () => {
		// With an active goal, stop semantics belong to the goal driver: the guard
		// must not stack a second nudge budget on top of it. The guard contract
		// is that it emits no task_complete nudge — continuation (if any) is the
		// goal driver's, not the guard's.
		cfgGoalEnabled.set(session.settings, true);
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		armStream(() => ({ text: "working" }));

		await session.prompt("do the work");
		await session.waitForIdle();

		// The guard stood down: no task_complete nudge was injected by it.
		expect(nudgeCount()).toBe(0);
	});

	it("exposes no content-carrying parameter on the marker", () => {
		// The user's final reply is the assistant text written before the marker
		// call. A declared parameter invites the model to move that reply into
		// the call (invisible once the run ends at the tool result), so the
		// marker declares none, and the wire object stays closed so strict
		// providers reject a legacy `reason` field instead of letting it
		// masquerade as the reply.
		const wire = toolWireSchema(new TaskCompleteTool());
		expect(wire.properties).toEqual({});
		expect(wire.additionalProperties).toBe(false);
	});
});
