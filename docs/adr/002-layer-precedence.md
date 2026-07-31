# ADR 002 — Hook-sourced state outranks heuristic state

**Status:** Accepted · shipped
**Scope:** `watcher/watcher.mjs`, `watcher/scanner.mjs`

## Context

Session state is produced by three layers of decreasing reliability (see the detection ladder
in the README). Layer 1 is the agent telling us, through its own hook system, that it is
waiting for a human. Layer 2 is a regex scanner reading rendered TUI output. Layer 3 is an LLM
reading the tail of the log.

The conclusion that Layer 1 must win for full-screen TUI agents had already been reached and
written down weeks earlier. **The code did not implement it.**

The guard in the write path looked like this:

```js
if (existing && existing.updated_at > olderThan) return;
```

That protects a state for exactly **one scan cycle**. On the next cycle, `updated_at` is older
than the threshold, the guard opens, and the scanner overwrites a hook-confirmed
`waiting_for_input` with `idle` — because a blocked TUI produces no new log lines, and "no new
output" is indistinguishable from "finished" to a regex.

### Production evidence

On one host, one session, over roughly two hours:

```
11 permission_request hook events between 10:29 and 12:17 UTC — every one demoted
last hook   12:17:56
state_since 12:18:02.680   ← 6 seconds later, with no hook event in between
```

Six seconds. Eleven times. The agent was asking for permission and the cockpit kept announcing
that it was idle. This is the exact failure the entire phase existed to eliminate, produced by
the system built to eliminate it.

Field evidence later showed the LLM classifier could demote the state too — the defect was in
the write path, not in any one layer.

## Decision

**1. State carries its provenance.** `session_state` gains a `source` column
(`hook` | `heuristic`), migrated additively with a `DEFAULT 'heuristic'` so existing rows stay
valid.

**2. Hook-sourced `waiting_for_input` cannot be demoted by a heuristic.** The scanner and the
classifier both write through one path, and that path refuses to overwrite it.

**3. Only `waiting_for_input` is shielded — not every hook-sourced state.** This restriction is
deliberate and was the hard call. Shielding *all* hook state would freeze `thinking` for
hook-enabled sessions: the agent emits a hook when it starts working, and after that only
Layer 2 can observe it going quiet. Shielding everything would trade a false `idle` for a
false `thinking`, which is the same bug wearing a different mask.

**4. The lock is released by three events only:**

- another hook — `Stop` means the agent finished and is authoritative about that;
- the operator answering the question, but **only when no pending decision remains** for that
  session (a session can hold two open questions; answering one must not unlock the other);
- marking a decision `dismissed`, under the same condition.

Marking a decision `seen` releases nothing. Acknowledging that a question exists is not the
same as resolving it, and conflating the two would re-create the original bug through the UI.

**5. Sessions without hooks are untouched.** They have no `hook`-sourced rows, the guard never
engages, and Layer 2 governs them exactly as before.

## Consequences

**Good**

- The written conclusion and the running code now agree.
- The precedence rule lives in one function, so the classifier inherits it for free.
- The regression is covered by a test that **replays the production timeline above** — the
  eleven-cycle sequence with no calm signal in between. It fails against the old code.

**Costs accepted**

- A hook that fires `waiting_for_input` and then dies without a `Stop` leaves the state pinned
  until the operator interacts. This is the correct trade: a stuck "someone needs you" is
  visible and annoying; a stuck "all clear" is invisible and dangerous.
- Provenance must now be threaded through every write path — a small, permanent tax on adding
  a fourth detection source later.

## Principle extracted

> When multiple sources of differing reliability write to the same state, the write path must
> know **where each value came from**. Precedence enforced by timing — "the most recent write
> wins" — degrades into "the noisiest source wins", and the noisiest source is usually the
> least reliable one.
