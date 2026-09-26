import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { GoalModeState } from "../goals/state";

/** 无进展续跑的放行上限:模型确认轮(纯文本)重发 nudge 的最大次数。 */
const MAX_NO_PROGRESS_CONTINUATIONS = 2;
/** 同一错误签名连续出现超过该次数即暂停 goal(用户新 prompt 自动 resume 后重新开始重连)。 */
const MAX_SAME_ERROR_SETTLES = 10;
/** 认证类失败(key 失效等):重连无意义,立即停止。 */
const AUTH_ERROR_STATUSES: Record<number, true> = { 401: true, 403: true };

/**
 * Session-layer goal continuation driver.
 *
 * Owns the "keep working toward the active goal" loop that used to live in the
 * interactive TUI as an 800ms auto-submit timer. After every `agent_end`, when
 * a goal is active, this submits the hidden `goal-continuation` prompt through
 * `promptCustomMessage` — the same channel the TUI used, so the wire shape,
 * customType, and transcript handling are unchanged and every run mode
 * (interactive, RPC, ACP, headless) gets the same behavior.
 *
 * Anti-loop guard: an agent_end that settles a goal-continuation turn is
 * fingerprinted (tool activity only, call IDs and timestamps excluded). If the
 * turn produced zero activity or identical activity to the previous
 * continuation turn, the next continuation is suppressed. Any real user
 * message (role=user, non-synthetic `message_start`) resets the chain.
 */
export class GoalContinuation {
	/** True while the previous submitted turn was a goal continuation awaiting its settle. */
	#awaitingContinuationSettle = false;
	/** Fingerprint of the last goal-continuation turn's tool activity. */
	#previousActivity: string | undefined;
	/** 同一错误签名连续出现的 error settle 次数;超过 MAX_SAME_ERROR_SETTLES 触发暂停。 */
	#sameErrorStreak = 0;
	/** 上一个 error settle 的错误签名(非 error settle 清零)。 */
	#errorFingerprint: string | undefined;
	/** Consecutive continuation turns that produced no new tool activity; bounded by MAX_NO_PROGRESS_CONTINUATIONS. */
	#noProgressContinuations = 0;

	constructor(
		private readonly host: {
			getGoalModeState: () => GoalModeState | undefined;
			promptCustomMessage: (message: {
				customType: "goal-continuation";
				content: string;
				display: false;
				attribution: "agent";
			}) => Promise<boolean>;
			hasPendingAsyncWake: () => boolean;
			/** 外部模式阻断(plan review / loop mode):这些时序下 goal 不得自动续跑。 */
			continuationBlocked: () => boolean;
			/** 用户主动中断(ESC)时调用:goal 转 paused,由 /goal resume 恢复。 */
			pauseGoal: () => Promise<GoalModeState | undefined> | GoalModeState | undefined;
			/** Continuation prompt for the active goal, or undefined when none is active. */
			buildContinuationPrompt: () => string | undefined;
			/** Suppression is scoped to one prompt cycle: a new prompt() resets it. */
			getPromptGeneration: () => number;
			/** 同步的暂停请求标志:ESC/abort 已请求 pause 但状态还在异步提交队列里时,本 settle 不得 re-arm。 */
			pauseRequested?: () => boolean;
		},
	) {}

	/** A real user message arrived — break any suppression chain in progress. */
	resetSuppression(): void {
		this.#awaitingContinuationSettle = false;
		this.#previousActivity = undefined;
		this.#noProgressContinuations = 0;
	}

	/**
	 * Evaluate an `agent_end` settle and schedule the goal continuation when
	 * appropriate. Returns true when a continuation turn was submitted (the
	 * caller must report `willContinue` and treat this settle as non-terminal).
	 */
	async maybeContinue(
		message: AssistantMessage,
		activeMessages: readonly AgentMessage[],
		options: { compactionOwned: boolean },
	): Promise<boolean> {
		const generationAtEntry = this.host.getPromptGeneration();
		const state = this.host.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active" || state.mode === "exiting") {
			this.#awaitingContinuationSettle = false;
			return false;
		}
		// pause 的状态提交走 accounting 队列是异步的;用户 ESC/abort 后本 settle
		// 可能仍读到 active。同步标志封闭这个竞态窗口:中断后不再 re-arm。
		if (this.host.pauseRequested?.()) {
			this.#awaitingContinuationSettle = false;
			return false;
		}
		if (options.compactionOwned) return false;
		if (this.host.continuationBlocked()) return false;
		if (this.host.hasPendingAsyncWake()) return false;
		// goal 运行期间 provider 错误不使会话停摆:重新提交续跑轮次持续重连,
		// 直到 (a) 认证类失败(401/403,key 失效,重连无意义)或
		// (b) 同一错误签名连续出现超过 MAX_SAME_ERROR_SETTLES 次。
		// 两种情况都转 paused(与 ESC 语义一致):用户新 prompt 经 agent_start
		// 自动 resume,重连循环重新开始(计数随暂停清零)。
		// 节奏由 TurnRecovery 的轮内退避天然提供,不另加 backoff。
		if (message.stopReason === "error") {
			const fingerprint = this.#errorFingerprintOf(message);
			this.#sameErrorStreak = fingerprint === this.#errorFingerprint ? this.#sameErrorStreak + 1 : 1;
			this.#errorFingerprint = fingerprint;
			const authFailure = message.errorStatus !== undefined && AUTH_ERROR_STATUSES[message.errorStatus] === true;
			if (authFailure || this.#sameErrorStreak > MAX_SAME_ERROR_SETTLES) {
				logger.warn(
					authFailure
						? "Goal auto-paused: auth failure, reconnect would not help"
						: "Goal auto-paused: same error repeated, reconnect budget exhausted",
					{ errorStatus: message.errorStatus, consecutive: this.#sameErrorStreak },
				);
				this.#sameErrorStreak = 0;
				this.#errorFingerprint = undefined;
				this.#awaitingContinuationSettle = false;
				void this.host.pauseGoal();
				return false;
			}
			// 重连:重新提交续跑轮次。走 settle 期宏任务延后提交,避开 agent 队列
			// 排水竞态(与无进展 nudge 同一模式)。
			this.#noProgressContinuations = 0;
			this.#awaitingContinuationSettle = true;
			const prompt = this.host.buildContinuationPrompt();
			if (!prompt) {
				this.#awaitingContinuationSettle = false;
				return false;
			}
			void Bun.sleep(0).then(async () => {
				if (this.host.getPromptGeneration() !== generationAtEntry) return;
				if (this.host.pauseRequested?.()) return;
				try {
					await this.host.promptCustomMessage({
						customType: "goal-continuation",
						content: prompt,
						display: false,
						attribution: "agent",
					});
				} catch (error) {
					this.#awaitingContinuationSettle = false;
					logger.debug("Goal reconnection submission skipped", { error });
				}
			});
			return true;
		} else {
			this.#sameErrorStreak = 0;
			this.#errorFingerprint = undefined;
		}
		// Only judge suppression when this settle ends a turn WE submitted;
		// otherwise (fresh user prompt etc.) the chain restarts cleanly.
		if (this.#awaitingContinuationSettle) {
			const activity = this.#activityFingerprint(activeMessages);
			if (activity === "" || activity === this.#previousActivity) {
				// 无新工具活动 ≠ 链条必须死:模型常有习惯性确认轮("I have processed
				// the tool results."),重发同一 continuation prompt 当 nudge 就能
				// 踢回去干活。连续超限才静默停,防真死循环烧 token。
				this.#noProgressContinuations++;
				if (this.#noProgressContinuations > MAX_NO_PROGRESS_CONTINUATIONS) {
					this.#previousActivity = activity;
					this.#awaitingContinuationSettle = false;
					logger.debug("Goal continuation suppressed: no-progress budget exhausted", {
						consecutive: this.#noProgressContinuations,
					});
					return false;
				}
				// ponytail: settle 期同步提交 followUp 链到第三个时撞 agent 队列
				// 排水竞态(turn 永不启动);宏任务延后一拍,落到已 unwind 的空闲
				// 会话走常规入口。根修在 pi-agent-core 排队机制,升级路径留那里。
				this.#awaitingContinuationSettle = true;
				const prompt = this.host.buildContinuationPrompt();
				if (!prompt) {
					this.#awaitingContinuationSettle = false;
					return false;
				}
				void Bun.sleep(0).then(async () => {
					if (this.host.getPromptGeneration() !== generationAtEntry) return;
					if (this.host.pauseRequested?.()) return;
					try {
						await this.host.promptCustomMessage({
							customType: "goal-continuation",
							content: prompt,
							display: false,
							attribution: "agent",
						});
					} catch (error) {
						this.#awaitingContinuationSettle = false;
						logger.debug("Goal continuation deferred submission skipped", { error });
					}
				});
				return true;
			}
			this.#noProgressContinuations = 0;
			this.#previousActivity = activity;
		}
		const prompt = this.host.buildContinuationPrompt();
		if (!prompt) return false;
		if (this.host.getPromptGeneration() !== generationAtEntry) return false;
		this.#awaitingContinuationSettle = true;
		try {
			await this.host.promptCustomMessage({
				customType: "goal-continuation",
				content: prompt,
				display: false,
				attribution: "agent",
			});
		} catch (error) {
			this.#awaitingContinuationSettle = false;
			// A busy session (queued input, streaming restart) means something else
			// owns the next turn already; the next agent_end re-evaluates.
			logger.debug("Goal continuation submission skipped", { error });
			return false;
		}
		return true;
	}

	/** Model-visible tool activity, excluding call IDs and timestamps that differ on every turn. */
	#activityFingerprint(messages: readonly AgentMessage[]): string {
		const digests: string[] = [];
		const record = (value: unknown): void => {
			const serialized = stableStringifyJson(value);
			digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
		};
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") record(["call", block.name, block.arguments]);
				}
			} else if (message.role === "toolResult") {
				record(["result", message.toolName, message.content, message.isError === true]);
			}
		}
		return digests.join(":");
	}
	/** 错误签名:有 HTTP 状态时以状态为准,否则取错误信息前 80 字符(传输类失败没有状态码)。 */
	#errorFingerprintOf(message: AssistantMessage): string {
		return message.errorStatus !== undefined
			? `status:${message.errorStatus}`
			: `msg:${String(message.errorMessage ?? "").slice(0, 80)}`;
	}
}
