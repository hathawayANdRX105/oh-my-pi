import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import taskCompleteDescription from "../prompts/tools/task-complete.md" with { type: "text" };

/**
 * `task_complete` — the explicit task stop guard (freebuff-style).
 *
 * Empty-parameter marker tool: the model calls it when the user's request is
 * fulfilled, it needs clarification, or it is blocked. A text-only stop with
 * no marker is NOT terminal while the guard is armed — the session nudges and
 * continues instead. The tool itself is stateless: the guard reads the
 * toolResult's presence from the settle path, so nothing lands in the
 * session's write path.
 *
 * A sole, successful marker also ENDS the run: the session aborts the loop with
 * the terminal-tool-result reason, so the model never buys another provider turn
 * to restate the answer it already wrote before the call.
 */

const taskCompleteSchema = type({}).describe("no arguments; the marker itself is the signal");

export interface TaskCompleteDetails {
	/** True when the marker was accepted (always, unless schema-level failure). */
	marker: true;
}

export class TaskCompleteTool implements AgentTool<typeof taskCompleteSchema, TaskCompleteDetails> {
	readonly name = "task_complete";
	readonly approval = "read" as const;
	readonly label = "TaskComplete";
	readonly summary = "Mark the current task complete (or signal you need user input / are blocked)";
	readonly description = prompt.render(taskCompleteDescription);
	readonly parameters = taskCompleteSchema;
	readonly strict = true;

	async execute(
		_toolCallId: string,
		_params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TaskCompleteDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TaskCompleteDetails>> {
		return {
			content: [{ type: "text", text: "Task marked complete. Control returns to the user." }],
			details: { marker: true },
		};
	}
}
