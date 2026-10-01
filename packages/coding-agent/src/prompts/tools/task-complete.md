Mark the current task complete — the explicit stop guard for the run.

Call this tool when exactly one of these is true:

- The user's request is completely fulfilled: all work is done and verified.
- You need clarification from the user before continuing (missing information, ambiguous requirement, decision only the user can make).
- You are blocked or stuck and need the user's help to continue.

Your reply is the assistant text you write, never a tool argument. Write the report — what you did, what you verified, what is left, anything blocking — as normal assistant text, then make this call the last action of that same turn. Do not batch it with other tool calls.

The marker is a hidden signal: the call and its result are stripped from your context, and the run ends as soon as you call it. You will not see any acknowledgement, and nothing you write after the call is ever delivered. So a turn that calls the marker without text first leaves the user with no report — write the text first, every time.

Do not call it while meaningful work remains — a plain text stop is treated as "not finished" and the run continues.
