Manage the session goal-mode objective.

Use a single `op` field:
- `create` starts a goal and enables goal mode. Requires `objective`. Optional `token_budget` must be positive — **omit it unless the user explicitly asks for a budget** (no budget = unbounded). Use when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

When the user states a multi-step or long-running objective and no goal is active, call `create` yourself with a clear objective and **no token_budget**.
NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
