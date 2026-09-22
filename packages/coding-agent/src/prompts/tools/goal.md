Manage the session goal-mode objective.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`. Never set `token_budget`; goals are unbounded in this build. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it.

When the user states a multi-step or long-running objective and no goal is active, call `create` yourself with a clear objective and no `token_budget`.
Paused goal from `get` → MUST `resume` before continuing work.
