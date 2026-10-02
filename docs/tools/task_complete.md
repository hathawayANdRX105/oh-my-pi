# task_complete

> Marks the current task complete — the explicit stop marker for the run.

## Source
- Entry: `packages/coding-agent/src/tools/task-complete.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task-complete.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates availability on `taskComplete.enabled`.
  - `packages/coding-agent/src/session/agent-session.ts` — reads the marker's tool result on the settle path, ends the run on a marked stop, and keeps the marker out of provider-bound history.
  - `packages/coding-agent/src/session/messages.ts` — drops the `task_complete` call and result from provider history (`convertToLlm`).

## Inputs

The tool takes **no arguments** — the marker itself is the signal.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| *(none)* | — | — | Calling the tool with an empty parameter object marks the current task complete. |

## Outputs
A single-shot `AgentToolResult`:

- `content`: one text part — `Task marked complete. Control returns to the user.`
- `details`: `{ marker: true }` — the session's settle path uses the successful marker result to end the run.

## Flow
1. The model calls `task_complete` when the user's request is fulfilled, clarification is needed, or the agent is blocked.
2. The tool executes immediately and returns the marker result; no tool call is actually dispatched to the host.
3. The session's tool-result handler records `#taskCompleteMarked` (`agent-session.ts`).
4. On the settle path, `#dischargeTaskCompleteMarker` consumes the marked flag and the stop settles terminally; the run ends and `isStreaming` drops to `false`.
5. `convertToLlm` strips the marker call and result from provider-bound history, so the model never re-learns that the call is what ends a reply. The marker stays in the persisted session transcript.

## Modes / Variants
- **Marker + user-facing text**: the run ends at the tool result — the session aborts the loop with the terminal-tool-result reason, so the model never buys another provider turn to restate its answer.
- **Silent marker (no text)**: the run stays alive so the model still gets its report turn; a degenerate marker-only loop is capped (`TASK_COMPLETE_MAX_SILENT_CONTINUATIONS`).
- **Marker batched with sibling tool calls**: not terminal — the sibling calls still run and the run settles on the following stop.
- **Text-only stop without the marker**: terminal — no nudge continuation is scheduled. Empty stops are handled by empty-stop recovery, and incomplete todo work is guarded by the todo reminder.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Persists the marker call and result in the session transcript (visible to the user) while keeping it out of provider-bound history.
- User-visible prompts / interactive UI
  - The transcript shows the marker chip; the run's "working" indicator clears when the stop settles.

## Limits & Caps
- Availability is gated by `taskComplete.enabled` (default `true`); the tool is only mounted at the top level (not inherited by subagents).
- Silent-marker continuation cap: `TASK_COMPLETE_MAX_SILENT_CONTINUATIONS = 2`.

## Errors
- Schema-level failures are the only error path: the empty parameter object must validate (`strict = true`); any extra property is rejected.

## Notes
- The marker is a stop **signal**, not a delivery channel: the user's final reply is the assistant text written before the marker call, never a tool argument.
- A turn that calls the marker without text first leaves the user with a marker chip and no report — the model-facing prompt instructs writing the report before the call.