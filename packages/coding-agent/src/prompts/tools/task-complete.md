Mark the current task complete — the explicit stop guard for the run.

Call this tool when exactly one of these is true:

- The user's request is completely fulfilled: all work is done and verified.
- You need clarification from the user before continuing (missing information, ambiguous requirement, decision only the user can make).
- You are blocked or stuck and need the user's help to continue.

The run ends at this tool's result: there is no follow-up turn, and anything you write after the call is never delivered. Your final reply to the user is the assistant text you write BEFORE this call, not a tool argument. State your result, evidence, and any blocking detail as that text, then make the call the last action of the turn — alone, never batched with other tool calls.

Do not call it while meaningful work remains — a plain text stop is treated as "not finished" and the run continues.
