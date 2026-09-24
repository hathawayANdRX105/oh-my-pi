import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { GoalModeState } from "../goals/state";

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
	/** Consecutive error settles on an active goal; 2 triggers auto-pause (provider broken). */
	#consecutiveErrorSettles = 0;

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
		},
	) {}

	/** A real user message arrived — break any suppression chain in progress. */
	resetSuppression(): void {
		this.#awaitingContinuationSettle = false;
		this.#previousActivity = undefined;
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
		// 连续 error settle = provider 连接有问题(如聚合站 4xx/连接失败),
		// 继续续跑只会空转(每圈一次失败请求,UI 一直"运行"但无产出)。
		// 两连败即暂停 goal(与 ESC 语义一致);恢复用 /goal resume 或新消息。
		if (message.stopReason === "error") {
			this.#consecutiveErrorSettles++;
			if (this.#consecutiveErrorSettles >= 2) {
				logger.warn("Goal auto-paused after repeated error settles", {
					errors: this.#consecutiveErrorSettles,
				});
				// 清零:resume 之后必须重新累计两次失败才再次自动暂停,
				// 否则计数残留会让用户刚 /goal resume 就因一次错误立刻再被暂停。
				this.#consecutiveErrorSettles = 0;
				this.#awaitingContinuationSettle = false;
				void this.host.pauseGoal();
				return false;
			}
		} else {
			this.#consecutiveErrorSettles = 0;
		}
		if (options.compactionOwned) return false;
		if (this.host.continuationBlocked()) return false;
		if (this.host.hasPendingAsyncWake()) return false;
		// Only judge suppression when this settle ends a turn WE submitted;
		// otherwise (fresh user prompt etc.) the chain restarts cleanly.
		if (this.#awaitingContinuationSettle) {
			const activity = this.#activityFingerprint(activeMessages);
			if (activity === "" || activity === this.#previousActivity) {
				this.#previousActivity = activity;
				this.#awaitingContinuationSettle = false;
				logger.debug("Goal continuation suppressed: no new activity", {
					repeat: activity !== "",
				});
				return false;
			}
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
}
