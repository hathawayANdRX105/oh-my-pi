import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * todo -> goal link contracts at the tracker boundary:
 * `setPhases` (the single phases chokepoint: tool results, panel edits,
 * branch rehydration) fires `host.onAllTodosCompleted` exactly when every
 * task in a non-empty list is "completed" — abandoned/blocked do not count.
 */
describe("TodoTracker onAllTodosCompleted hook", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-tracker-link-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	function makeTracker(): { tracker: TodoTracker; completions: number[] } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const completions: number[] = [];
		const host: TodoTrackerHost = {
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "todo.enabled": true }),
			model: () => model,
			agentKind: () => "main",
			emitSessionEvent: async () => {},
			scheduleAgentContinue: () => {},
			promptGeneration: () => 1,
			hasPendingAsyncWake: () => false,
			getActiveToolNames: () => ["todo"],
			getEnabledToolNames: () => ["todo"],
			toolRegistry: () => new Map(),
			planModeEnabled: () => false,
			prewalkWillHandoff: () => false,
			consumeLastServedToolChoiceLabel: () => undefined,
			onAllTodosCompleted: () => {
				completions.push(1);
			},
		};
		return { tracker: new TodoTracker(host), completions };
	}

	it("fires when every task in a non-empty list is completed", () => {
		const { tracker, completions } = makeTracker();

		tracker.setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "wire", status: "completed" },
				],
			},
			{ name: "Verify", tasks: [{ content: "tests", status: "completed" }] },
		]);

		expect(completions).toHaveLength(1);
	});

	it("does not fire when any task is abandoned or blocked", () => {
		const { tracker, completions } = makeTracker();

		tracker.setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "wire", status: "abandoned" },
				],
			},
		]);

		// 半弃用的列表不算完成:联动 goal 不能 auto-complete。
		expect(completions).toHaveLength(0);
	});

	it("does not fire while tasks are pending or in progress", () => {
		const { tracker, completions } = makeTracker();

		tracker.setPhases([{ name: "Build", tasks: [{ content: "scaffold", status: "in_progress" }] }]);

		expect(completions).toHaveLength(0);
	});

	it("does not fire on an empty list", () => {
		const { tracker, completions } = makeTracker();

		tracker.setPhases([]);

		expect(completions).toHaveLength(0);
	});
});
