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
		continuationBlocked?: () => boolean;
		pauseRequested?: () => boolean;
	},
) {
	const submissions: PromptSubmission[] = [];
	let currentState = state;
	let pauses = 0;
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
		continuationBlocked: options?.continuationBlocked ?? (() => false),
		pauseRequested: options?.pauseRequested ?? (() => false),
		pauseGoal: () => {
			pauses++;
			return Promise.resolve(currentState);
		},
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
		get pauses() {
			return pauses;
		},
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

	it("re-arms through no-progress continuation turns up to the budget, then suppresses", async () => {
		const h = makeHarness(makeState());
		// Settle of the continuation turn: zero tool activity → nudge (re-arm).
		const second = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(second).toBe(true);
		const third = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(third).toBe(true);
		// 预算(2)用尽:模型连续确认后仍无动作,停止续跑防烧 token。
		const fourth = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(fourth).toBe(true);
		const fifth = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(fifth).toBe(false);
		await Bun.sleep(5);
		expect(h.submissions).toHaveLength(3);
	});

	it("re-arms through repeated activity fingerprints up to the budget, then suppresses", async () => {
		const h = makeHarness(makeState());
		const same = [assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])] as never;
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// 指纹首次出现只播种;之后两个相同指纹的续跑轮在预算内重发 nudge。
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, same, { compactionOwned: false }),
		).toBe(true);
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, same, { compactionOwned: false }),
		).toBe(true);
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, same, { compactionOwned: false }),
		).toBe(true);
		// 第四个相同指纹:预算耗尽 → 抑制。
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, same, { compactionOwned: false }),
		).toBe(false);
		await Bun.sleep(5);
		expect(h.submissions).toHaveLength(4);
	});

	it("new tool activity resets the no-progress budget", async () => {
		const h = makeHarness(makeState());
		const activity = [assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])] as never;
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// 两轮无进展烧掉预算……
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// ……真实工具活动重置预算。
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, activity, {
				compactionOwned: false,
			}),
		).toBe(true);
		await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		// 预算重新计数:这轮无进展仍放行,而不是立即抑制。
		expect(
			await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
				compactionOwned: false,
			}),
		).toBe(true);
		await Bun.sleep(5);
		expect(h.submissions).toHaveLength(6);
	});

	it("skips re-arm while a pause request is pending, even though state still reads active", async () => {
		let pauseRequested = false;
		const h = makeHarness(makeState(), { pauseRequested: () => pauseRequested });
		const scheduled = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(scheduled).toBe(true);
		// ESC 竞态:pause 已同步请求,但 paused 状态还在 accounting 队列里没提交。
		pauseRequested = true;
		const raced = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, NO_ACTIVITY, {
			compactionOwned: false,
		});
		expect(raced).toBe(false);
		expect(h.submissions).toHaveLength(1);
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
			continuationBlocked: () => false,
			pauseGoal: () => Promise.resolve(state),
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
		// fingerprint: the repeat re-arms within budget instead of seeding fresh.
		const after = await h.driver.maybeContinue({ role: "assistant", content: [] } as never, activity() as never, {
			compactionOwned: false,
		});
		expect(after).toBe(true);
		const afterSecond = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			activity() as never,
			{ compactionOwned: false },
		);
		expect(afterSecond).toBe(true);
		const afterThird = await h.driver.maybeContinue(
			{ role: "assistant", content: [] } as never,
			activity() as never,
			{ compactionOwned: false },
		);
		expect(afterThird).toBe(false);
		// Bun.sleep(0) 的 nudge 提交是真实宏任务,fake timers 无法驱动;5ms flush 等它落账。
		await Bun.sleep(5);
		expect(h.submissions).toHaveLength(4);
	});

	it("skips when a host mode blocks continuation (plan review / loop mode)", async () => {
		const h = makeHarness(makeState(), { continuationBlocked: () => true });
		const scheduled = await h.driver.maybeContinue(
			{ role: "assistant", content: [{ type: "text", text: "done" }] } as never,
			NO_ACTIVITY,
			{ compactionOwned: false },
		);
		expect(scheduled).toBe(false);
		expect(h.submissions).toHaveLength(0);
	});

	it("reconnects on error settles; auto-pauses only on auth failure or >10 consecutive same-code errors", async () => {
		const error502 = {
			role: "assistant" as const,
			content: [],
			stopReason: "error" as const,
			errorStatus: 502,
			errorMessage: "502 JSON error injected into SSE stream",
		} as never;
		/** 驱动者的延后重连提交恰好落在一个宏任务 tick(Bun.sleep(0));单 tick 冲刷,零真实时长。 */
		const flushDeferred = async (): Promise<void> => {
			await Bun.sleep(0);
		};

		// 502 重连循环:持续重新提交续跑轮次,不暂停。
		const h = makeHarness(makeState());
		for (let i = 0; i < 10; i++) {
			expect(await h.driver.maybeContinue(error502, NO_ACTIVITY, { compactionOwned: false })).toBe(true);
			await flushDeferred();
			expect(h.pauses).toBe(0);
		}
		expect(h.submissions).toHaveLength(10);

		// 同码第 11 次连续出现:重连预算耗尽,自动暂停。
		expect(await h.driver.maybeContinue(error502, NO_ACTIVITY, { compactionOwned: false })).toBe(false);
		expect(h.pauses).toBe(1);

		// 不同错误码交替出现不累积:502/503 反复,不暂停。
		const h3 = makeHarness(makeState());
		const error503 = {
			role: "assistant" as const,
			content: [],
			stopReason: "error" as const,
			errorStatus: 503,
			errorMessage: "503",
		} as never;
		for (let i = 0; i < 6; i++) {
			expect(await h3.driver.maybeContinue(i % 2 ? error503 : error502, NO_ACTIVITY, { compactionOwned: false })).toBe(true);
			await flushDeferred();
		}
		expect(h3.pauses).toBe(0);
		expect(h3.submissions).toHaveLength(6);

		// 认证失败(401):第一次即暂停,不重连。
		const h4 = makeHarness(makeState());
		const error401 = {
			role: "assistant" as const,
			content: [],
			stopReason: "error" as const,
			errorStatus: 401,
			errorMessage: "Invalid API key",
		} as never;
		expect(await h4.driver.maybeContinue(error401, NO_ACTIVITY, { compactionOwned: false })).toBe(false);
		expect(h4.pauses).toBe(1);
		await flushDeferred();
		expect(h4.submissions).toHaveLength(0);

		// 成功 settle 清零连败:502 ×5 被一次成功打断后再来 502 ×5 仍不暂停。
		const h5 = makeHarness(makeState());
		const okSettle = {
			role: "assistant" as const,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop" as const,
		} as never;
		for (let i = 0; i < 5; i++) {
			await h5.driver.maybeContinue(error502, NO_ACTIVITY, { compactionOwned: false });
			await flushDeferred();
		}
		await h5.driver.maybeContinue(okSettle, NO_ACTIVITY, { compactionOwned: false });
		await flushDeferred();
		for (let i = 0; i < 5; i++) {
			await h5.driver.maybeContinue(error502, NO_ACTIVITY, { compactionOwned: false });
			await flushDeferred();
		}
		expect(h5.pauses).toBe(0);
	});
});
