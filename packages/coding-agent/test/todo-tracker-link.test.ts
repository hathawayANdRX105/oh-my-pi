import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * todo -> goal link contracts:
 * - `checkCompletion` fires `host.onAllTodosCompleted` exactly when every
 *   task in a non-empty list is "completed" (abandoned/blocked do not count).
 */
function makeHost(onAllTodosCompleted: () => void): TodoTrackerHost {
	const agentStub = {} as never;
	const sessionManagerStub = {} as never;
	const settings = Settings.isolated({ "todo.enabled": true, "todo.reminders": true });
	return {
		agent: agentStub,
		sessionManager: sessionManagerStub,
		settings,
		model: () => undefined,
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
		onAllTodosCompleted,
	};
}

function assistantStop(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "all done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("TodoTracker onAllTodosCompleted hook", () => {
	it("fires when every task in a non-empty list is completed", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: TempDir.createSync("@pi-todo-tracker-link-").path() });
		const hook = vi.fn();
		const tracker = new TodoTracker(makeHost(() => hook()));
		tracker.setPhases([
			{
				name: "Build",
				tasks: [{ content: "scaffold", status: "completed" }, { content: "wire", status: "completed" }],
			},
			{ name: "Verify", tasks: [{ content: "tests", status: "completed" }] },
		]);

		const scheduled = await tracker.checkCompletion(assistantStop());

		expect(scheduled).toBe(false);
		expect(hook).toHaveBeenCalledTimes(1);
		resetSettingsForTest();
	});

	it("does not fire when tasks are abandoned or blocked", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: TempDir.createSync("@pi-todo-tracker-link-2-").path() });
		const hook = vi.fn();
		const tracker = new TodoTracker(makeHost(() => hook()));
		tracker.setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "wire", status: "abandoned" },
				],
			},
		]);

		await tracker.checkCompletion(assistantStop());

		// 半弃用的列表不算完成:联动 goal 不能 auto-complete。
		expect(hook).not.toHaveBeenCalled();
		resetSettingsForTest();
	});
});
