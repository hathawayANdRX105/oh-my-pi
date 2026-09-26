import { beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Unit-level contract for TodoTracker's stop-time reminder budget.
 *
 * The reminder budget is "consecutive no-progress reminder chains": tool-level
 * progress refreshes it, and a branch transition (rewind/fork/switch) resets
 * the whole cycle so a stale stall flag cannot suppress the next stop-time
 * pass on the rehydrated branch.
 */
function makeTracker(
	settings: Settings,
	sessionManager: SessionManager,
	options?: { goalContinuationActive?: () => boolean },
): { tracker: TodoTracker; reminders: number[] } {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const reminders: number[] = [];
	const host: TodoTrackerHost = {
		agent,
		sessionManager,
		settings,
		model: () => model,
		agentKind: () => "main",
		emitSessionEvent: async event => {
			if (event.type === "todo_reminder") reminders.push(event.attempt);
		},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		getActiveToolNames: () => ["todo"],
		getEnabledToolNames: () => ["todo"],
		toolRegistry: () => new Map(),
		planModeEnabled: () => false,
		goalContinuationActive: options?.goalContinuationActive ?? (() => false),
		prewalkWillHandoff: () => false,
		consumeLastServedToolChoiceLabel: () => undefined,
	};
	return { tracker: new TodoTracker(host), reminders };
}

function stopMessage(text = "paused"): AssistantMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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

function errorMessage(): AssistantMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage: "502 JSON error injected into SSE stream",
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

function appendTodoPhases(sessionManager: SessionManager, phases: unknown[]): void {
	sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
}

describe("TodoTracker reminder budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-tracker-");
	});

	it("a branch transition resets the reminder cap counter so a rehydrated cycle can fire", async () => {
		const settings = Settings.isolated({
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 3,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { tracker, reminders } = makeTracker(settings, sessionManager);

		tracker.setPhases([{ name: "Work", tasks: [{ content: "task A", status: "pending" }] }]);
		// Burn the cap: after 3 reminders the next stop is held.
		for (let i = 0; i < 3; i++) {
			expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		}
		expect(await tracker.checkCompletion(stopMessage())).toBe(false);
		expect(reminders).toEqual([1, 2, 3]);

		// Rewind/fork to a branch that also carries an incomplete todo:
		// rehydration resets the cycle, so the rehydrated branch can fire again.
		appendTodoPhases(sessionManager, [{ name: "Work", tasks: [{ content: "task B", status: "pending" }] }]);
		tracker.syncFromBranch();

		expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		expect(reminders).toEqual([1, 2, 3, 1]);
	});

	it("a view todo result does not refresh the reminder cap; a mutating op does", async () => {
		const settings = Settings.isolated({
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 1,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { tracker, reminders } = makeTracker(settings, sessionManager);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "task A", status: "pending" }] }]);

		// View op: no state change, no progress -> the cap (1) holds the chain.
		expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		tracker.onToolResult("todo", false, { op: "view", phases: tracker.phases });
		expect(await tracker.checkCompletion(stopMessage())).toBe(false);
		expect(reminders).toEqual([1]);

		// Mutating op with progress: the cap refreshes and the chain continues.
		tracker.setPhases([{ name: "Work", tasks: [{ content: "task A", status: "pending" }] }]);
		tracker.resetCycle();
		expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		tracker.onToolResult("todo", false, { op: "done", phases: tracker.phases });
		expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		expect(reminders).toEqual([1, 1, 1]);
	});

	it("skips the error-settle reminder while an active goal owns the continuation", async () => {
		const settings = Settings.isolated({
			"todo.enabled": true,
			"todo.reminders": true,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let goalActive = false;
		const { tracker, reminders } = makeTracker(settings, sessionManager, {
			goalContinuationActive: () => goalActive,
		});
		tracker.setPhases([{ name: "Work", tasks: [{ content: "task A", status: "pending" }] }]);

		// No active goal: an error-settled stop still takes the reminder (todo.resumeAfterError path).
		expect(await tracker.checkCompletion(errorMessage())).toBe(true);
		expect(reminders).toEqual([1]);

		// Goal active: the next error settle must not stack a second failing turn on top
		// of the goal-continuation semantics (502 amplification on a broken provider).
		tracker.resetCycle();
		goalActive = true;
		expect(await tracker.checkCompletion(errorMessage())).toBe(false);
		expect(reminders).toEqual([1]);

		// Non-error stops are not gated by the goal hook: the reminder still fires.
		tracker.resetCycle();
		expect(await tracker.checkCompletion(stopMessage())).toBe(true);
		expect(reminders).toEqual([1, 1]);
	});
});
