# 0002. Reliable ESC stop for running turns and goal continuation

**Date**: 2026-09-24
**Status**: Proposed

## Summary

Pressing ESC should always stop whatever is actually running: a model stream, a goal that keeps auto continuing, a retry, or a compaction. Today one ESC press does not reliably do that, so a long running goal can keep going even after you press stop. This spec makes one ESC stop the active run and, when the run is a goal, pause that goal so it does not silently re arm.

## Context

The coding agent runs in the terminal. When a turn is generating a model stream, or a goal runner keeps auto continuing after each idle turn, the user's only way to stop it is the ESC key. In practice ESC fails to stop the run in two common cases: a goal that re arms itself each turn, and a run that has been going for a long time. The user reports that after such a run ESC appears to do nothing.

The goal runner works by re arming itself on every idle agent end event. After a turn finishes without user input, the runner checks whether a goal is active and, if so, starts the next turn automatically. Pressing ESC interrupts the current turn, but two problems make that interrupt unreliable. First, the abort that ESC issues is fire and forget: it asks the agent to stop but does not wait for the stop to take, so a goal that is mid turn can continue anyway. Second, the goal state machine and the ESC handler disagree about who pauses the goal on interrupt, so the goal can be left active even after an interrupt, which means the next idle event re arms it and the loop continues.

The consequence of not deciding: the user has no dependable way to stop a runaway goal or a long turn, which breaks interactive control of the agent.

## Requirements

**User stories**:
- As a user driving the terminal agent, I want one ESC press to stop whatever is currently running so that I always have control.
- As a user who started a long goal, I want ESC to pause that goal so that it does not keep auto continuing after I stop it.

**Acceptance criteria**:
- **AC-1**: While a model stream is live, one ESC press stops that stream (the abort actually takes, not just requested).
- **AC-2**: While a goal auto continuation turn is running, one ESC press stops the whole loop, so the next idle agent end does not re arm the goal.
- **AC-3**: After an ESC interrupt of a running goal, the goal is in a paused (resumable) state, not dropped; it can be resumed with the goal resume action or a new user message.
- **AC-4**: ESC covers every active run state (model streaming, goal continuation, retry, compaction, handoff) under one rule: ESC stops the currently running thing.
- **AC-5**: When ESC is pressed with queued not yet sent input pending, the stream stops and the queued text is restored to the editor instead of being dropped.
- **AC-6**: After an interrupt, the goal continuation suppression and re arm counters are reset so the goal does not re fire on the following idle agent end.

## Options considered

### Option 1: Fix in place (targeted)

Change the ESC handler so that an active run is detected and stopped as one case, pause the goal on interrupt, and make the goal runner not re arm after an interrupt.

**Pros**:
- Small, single file scoped diff to the input controller and the goal runner.
- Matches the user expectation: one key, one stop.
- No new subsystem; reuses the existing abort and goal pause plumbing.

**Cons**:
- Requires getting the interrupt to goal pause ordering exactly right; a miss leaves the old bug.

### Option 2: Replace goal runner with a cancellable token

Build a new cancellation token threaded through the goal runner and the session, so a stop always propagates.

**Pros**:
- Clean propagation of cancellation by design.

**Cons**:
- Much larger blast radius across the session and goal runtime; overkill for a targeted interrupt bug.

### Option 3: Gate goal continuation behind a manual re arm

Remove auto continuation; require the user to press continue for each goal turn.

**Pros**:
- Trivially stoppable.

**Cons**:
- Destroys the goal feature value (autonomous multi turn completion).

## Decision

**Chosen option**: Option 1: Fix in place.

Make one ESC press stop the active run as a single detected case, pause the running goal on interrupt, and keep the goal runner from re arming after an interrupt.

## Rationale

Fix in place because the defect is localized to the ESC dispatch order and the interrupt to goal pause handoff, both inside the coding agent input controller and goal runner. There is no data to migrate and the change reverts cleanly as one commit, so the cancel token subsystem (Option 2) buys nothing for a targeted bug and the manual re arm gate (Option 3) removes the goal feature's core value. Fixing in place keeps the existing goal pause and abort plumbing and only corrects their ordering, which is exactly the state sensitive part the tests guard. One deliberate tradeoff is the single press stop: a stray ESC can cut off a long intended goal run, and this is accepted because the goal pauses (resumable) rather than being lost.

## Feature design

**State transitions** (goal + run):
- Run states: `idle` → `streaming` → (goal auto turn) → `idle`. ESC in any non idle run state = stop.
- Goal on interrupt: `active` → `paused` (on ESC that interrupts a goal run). `paused` → `active` on goal resume or a new user message. `active` → `dropped` only on explicit goal drop, never on ESC.

**Active run signal** (defines AC-4):
- A single boolean decides whether a run is active: `active` is true when the model is streaming OR an LLM request is in flight. This subsumes goal continuation auto turns and LLM retry. Compaction and handoff count as active only while they drive a turn; at idle they are not active.

**Pinned interrupt sequence** (the order that must hold or the bug regresses):
1. ESC stops the active run, awaited, not fire and forget.
2. The stop routes through `onTaskAborted(reason: "interrupted")`, the only seam that pauses the goal; an `internal` abort does not pause.
3. Goal goes `active → paused`, and the suppression and re arm counters are reset in the same interrupt.
4. On the next idle agent end the goal runner sees the goal not active and does not re arm.
- Step 3 is a double safety: pause alone leaves the counters and reset alone leaves the goal active; both are required to stop the loop.

**Key invariants**:
- A goal that is not active is never re armed by the goal runner (the runner checks goal active before starting a turn).
- An interrupt always leaves the goal not active (paused), so the invariant above stops the loop.
- ESC with queued input restores the queued text; it never silently drops user typed input.

**Security model**:
- Not applicable. This is a local interactive control behavior; no new data access.

**Configuration required**:
- None.

**Critical test scenarios** (each maps to an acceptance criterion in Requirements):
- Happy path: press ESC during a live model stream and the stream stops, verifies **AC-1**.
- Goal loop: press ESC during a goal auto continuation turn and the loop stops (no re arm on the next idle event), verifies **AC-2**, **AC-6**.
- Resume: after an ESC interrupt, the goal is paused and goal resume re activates it, verifies **AC-3**.
- Queued input: press ESC with pending queued text and the text returns to the editor, verifies **AC-5**.
- All active states: ESC stops a retry or compaction run the same way it stops a stream, verifies **AC-4**.

## Build plan

Ordered, single slice (Tracer Bullet, one deployable fix):

1. Detect the active run as one case in the ESC handler: a run is active when the model is streaming or an LLM request is in flight (covers goal continuation auto turns and retry), satisfying **AC-1**, **AC-4**.
2. On that case, stop the run effectively (awaited, not fire and forget) by routing through `onTaskAborted(reason: "interrupted")` so the running goal pauses and is not left active, satisfying **AC-2**, **AC-3**.
3. In the goal runner, after an interrupt reset the suppression and re arm counters so the next idle agent end does not re fire, satisfying **AC-6**, **AC-2**.
4. When ESC aborts with queued input pending, restore the queued text to the editor instead of dropping it, satisfying **AC-5**.

## Consequences

**Positive**:
- One dependable stop control for every running state.
- Goals stop cleanly and stay paused until explicitly resumed.

**Negative / tradeoffs**:
- The interrupt to goal pause ordering is state sensitive; a missed ordering regresses the original bug, so the tests above are the guard.
- Restoring queued input means an interrupted turn leaves text in the editor rather than discarding it, which is the desired behavior but changes the old clear on abort path.
- A single press stop can cut off a long intended goal run if ESC is pressed by accident; this is accepted because the goal pauses (resumable) rather than being lost.

**Neutral**:
- The existing goal resume flow now has a clearly reachable paused entry point from ESC.

## Follow-up

- [ ] Add a regression test that holds a goal loop open, presses ESC once, and asserts no re arm on the next idle event.
- [ ] Confirm ESC during a non goal long streaming turn also stops reliably (AC-1) with the abort awaited.
