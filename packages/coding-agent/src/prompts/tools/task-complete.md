Mark the current task complete — the explicit stop guard for the run.

Call this tool when exactly one of these is true:

- The user's request is completely fulfilled: all work is done and verified.
- You need clarification from the user before continuing (missing information, ambiguous requirement, decision only the user can make).
- You are blocked or stuck and need the user's help to continue.

Calling it ends your turn and returns control to the user. Do not call it while meaningful work remains — a plain text stop is treated as "not finished" and the run continues.
