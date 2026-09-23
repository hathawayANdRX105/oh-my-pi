import { describe, expect, it } from "bun:test";
import { GoalContinuation } from "../src/session/goal-continuation";
import type { GoalModeState } from "../src/goals/state";

type PromptSubmission = { customType: "goal-continuation"; content: string; display: false; attribution: "agent" };

function makeState(overrides?: Partial<GoalModeState>): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "g1",
			objective: "Ship the feature",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
		},
		...overrides,
	};
}

function assistantMessage(content: Array<{ type: string; name?: string; arguments?: unknown; text?: string }>) {
	return { role: "assistant" as const, content };
}

function makeHarness(
	state?: GoalModeState,
	options?: {
		promptGeneration?: number;
		promptCustomMessage?: (message: PromptSubmission) => Promise<boolean>;
		hasPendingAsyncWake?: () => boolean;
		buildContinuationPrompt?: (currentState: GoalModeState | undefined) => string | undefined;
	},
) {
	const submissions: PromptSubmission[] = [];
	let currentState = state;
	let generation = options?.promptGeneration ?? 1;
	const host = {
		getGoalModeState: () => currentState,
		promptCustomMessage:
			options?.promptCustomMessage ??
			((message: PromptSubmission) => {
				submissions.push(message);
				return Promise.resolve(true);
			}),
		hasPendingAsyncWake: options?.hasPendingAsyncWake ?? (() => false),
		buildContinuationPrompt: () =>
			options?.buildContinuationPrompt
				? options.buildContinuationPrompt(currentState)
				: currentState?.enabled
					? `continue: ${currentState.goal.objective}`
					: undefined,
		getPromptGeneration: () => generation,
	};
	const driver = new GoalContinuation(host);
	return {
		driver,
		submissions,
		setState(next: GoalModeState | undefined) {
			currentState = next;
		},
		bumpGeneration() {
			generation++;
		},
	};
}

const NO_ACTIVITY = [] as never[];

describe("GoalContinuation", () => {
	it("submits a hidden goal-continuation prompt on a normal settle", async () => {
		const h = makeHarness(makeState());
		const scheduled = await h.driver.maybeContinue(
			{ role: "assistant", content: [{ type: "text", text: "done for now" }] } as never,
			NO_ACTIVITY,
			{ compactionOwned: false },
		);
		expect(scheduled).toBe(true);
		expect(h.submissions).toHaveLength(1);
		expect(h.submissions[0].customType).toBe("goal-continuation");
		expect(h.submissions[0].display).toBe(false);
		expect(h.submissions[0].content).toContain("Ship the feature");
	});

	it("skips when no goal is active", async () => {
		const h = makeHarness(undefined);
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("skips when the settle is owned by compaction", async () => {
		const h = makeHarness(makeState());
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: true,
		});
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("suppresses after a continuation turn with zero activity", async () => {
		const h = makeHarness(makeState());
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// Settle of the continuation turn we just submitted: zero activity → suppress.
		const second = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(second).toBe(false);
		expect(h.submissions).toHaveLength(1);
	});

	it("suppresses when a continuation turn repeats the same activity fingerprint", async () => {
		const h = makeHarness(makeState());
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// First continuation turn settled with tool activity → continue.
		const second = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			[assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])] as never,
			{ compactionOwned: false },
		);
		expect(second).toBe(true);
		// Second continuation turn settled with IDENTICAL activity → suppress.
		const third = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			[assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])] as never,
			{ compactionOwned: false },
		);
		expect(third).toBe(false);
		expect(h.submissions).toHaveLength(2);
	});

	it("continues again when the continuation turn produces different activity", async () => {
		const h = makeHarness(makeState());
		const firstActivity = [assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])];
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, firstActivity as never, {
			compactionOwned: false,
		});
		const secondActivity = [assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "b.ts" } }])];
		const second = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			secondActivity as never,
			{
				compactionOwned: false,
			},
		);
		expect(second).toBe(true);
		expect(h.submissions).toHaveLength(2);
	});

	it("a real user message resets the suppression chain", async () => {
		const h = makeHarness(makeState());
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		h.driver.resetSuppression();
		const next = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(next).toBe(true);
		expect(h.submissions).toHaveLength(2);
	});

	it("aborts submission when the prompt generation moves on before submit", async () => {
		// A competing prompt() claims the session between our entry snapshot and
		// the submit check: the continuation must not fire for a stale cycle.
		const submissions: PromptSubmission[] = [];
		let generation = 1;
		const state = makeState();
		const driver = new GoalContinuation({
			getGoalModeState: () => state,
			promptCustomMessage: message => {
				submissions.push(message);
				return Promise.resolve(true);
			},
			hasPendingAsyncWake: () => false,
			buildContinuationPrompt: () => {
				// Last host call before the submit check: simulate the new prompt
				// landing here.
				generation++;
				return `continue: ${state.goal.objective}`;
			},
			getPromptGeneration: () => generation,
		});
		const scheduled = await driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		expect(submissions).toHaveLength(0);
	});

	it("skips when the goal is exiting", async () => {
		const h = makeHarness(makeState({ mode: "exiting" }));
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("skips non-active goal statuses (budget-limited, complete, dropped)", async () => {
		for (const status of ["budget-limited", "complete", "dropped"] as const) {
			const h = makeHarness(makeState({ goal: { ...makeState().goal, status } }));
			const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
				compactionOwned: false,
			});
			expect(scheduled).toBe(false);
			expect(h.submissions).toHaveLength(0);
		}
	});

	it("skips a paused goal (enabled false, status paused)", async () => {
		const h = makeHarness(makeState({ enabled: false, goal: { ...makeState().goal, status: "paused" } }));
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("skips while async jobs are pending (they re-wake the loop)", async () => {
		const h = makeHarness(makeState(), { hasPendingAsyncWake: () => true });
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("cleans up cleanly when the continuation prompt is unavailable", async () => {
		let promptAvailable = false;
		const h = makeHarness(makeState(), {
			buildContinuationPrompt: currentState =>
				currentState?.enabled && promptAvailable ? `continue: ${currentState.goal.objective}` : undefined,
		});
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(false);
		// State must stay clean: the very next normal settle still submits.
		promptAvailable = true;
		const next = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(next).toBe(true);
		expect(h.submissions).toHaveLength(1);
	});

	it("recovers when promptCustomMessage throws (busy race) and retries on the next settle", async () => {
		let throwFirst = true;
		const h = makeHarness(makeState(), {
			promptCustomMessage: message => {
				if (throwFirst) {
					throwFirst = false;
					throw new Error("AgentBusyError");
				}
				h.submissions.push(message);
				return Promise.resolve(true);
			},
		});
		const first = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(first).toBe(false);
		expect(h.submissions).toHaveLength(0);
		// The next settle must be able to submit again (awaiting state was reset).
		const second = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(second).toBe(true);
		expect(h.submissions).toHaveLength(1);
	});

	it("fingerprint distinguishes identical calls with different tool results", async () => {
		const h = makeHarness(makeState());
		const call = { type: "toolCall", name: "read", arguments: { path: "a.ts" } };
		const resultFor = (text: string) => [
			assistantMessage([call]),
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "t1",
				content: [{ type: "text", text }],
			},
		];
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, resultFor("v1") as never, {
			compactionOwned: false,
		});
		const second = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			resultFor("v2") as never,
			{
				compactionOwned: false,
			},
		);
		expect(second).toBe(true);
		expect(h.submissions).toHaveLength(2);
	});

	it("preserves suppression state across a compaction-owned settle", async () => {
		const h = makeHarness(makeState());
		const activity = () => [assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])];
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, activity() as never, {
			compactionOwned: false,
		});
		// Continuation turn settles with activity A -> continues (previous=A).
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, activity() as never, {
			compactionOwned: false,
		});
		// A compaction-owned settle must NOT clobber the suppression state...
		const duringCompaction = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			activity() as never,
			{ compactionOwned: true },
		);
		expect(duringCompaction).toBe(false);
		// ...so the next normal settle still compares against the pre-compaction
		// fingerprint and suppresses the repeat.
		const after = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, activity() as never, {
			compactionOwned: false,
		});
		expect(after).toBe(false);
		expect(h.submissions).toHaveLength(2);
	});
});
