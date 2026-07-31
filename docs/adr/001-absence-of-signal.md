# ADR 001 — Absence of signal renders as unknown, never as healthy

**Status:** Accepted · shipped
**Scope:** `watcher/watcher.mjs`, `server/src/watcher/poller.ts`, `web/src/lib/session-coverage.ts`

## Context

The product promise was never "detect agent state". It was **"you can walk away"**. That
promise rests on a premise the UI asserted without holding: that it is actually watching.

The status resolver ended like this:

```ts
return watcherState ?? 'idle';
```

A session that was watched and genuinely calm resolved to `idle`. A session the watcher could
not see **also** resolved to `idle`. On screen they were identical.

The irony was documented in the file itself: a comment warned that inventing state without a
real signal "would be a fabrication" — which is precisely what `?? 'idle'` did. It converted
*absence of information* into *an assertion of calm*.

Two field incidents priced this:

| Date | What broke | What the operator saw |
|---|---|---|
| 2026-07-17 | `pipe-pane` logging died on 4 of 6 sessions after a `tmux-resurrect` restore | normal indicator, silence |
| 2026-07-21 | A full-screen TUI agent was waiting for input; state stuck on `thinking` | no warning, agent parked |

A tool that fails silently is worse than one that fails loudly, because you trust it and
leave the house.

A second defect made "how long has this been quiet?" unanswerable: `updated_at` was bumped on
every write, including scans that changed nothing. There was no way to distinguish a state
that had just changed from one that had been frozen for two hours.

## Decision

**1. Two clocks, not one.** `session_state` carries both:

- `updated_at` — heartbeat. Advances on every write. Answers *"is the watcher alive?"*
- `state_since` — transition timestamp. Advances **only when the state actually changes**.
  Answers *"how long has it been like this?"*

**2. Coverage is derived, in one pure function.** `deriveCoverage()` takes the session, its
state, both clocks and the current time, and returns a coverage verdict. It is pure, it lives
in one file, and it is tested independently of React and of the network.

**3. Unknown is a first-class rendering.** A session with no telemetry renders as `⃠` —
visually distinct from every watched state. The UI says *"I don't know"*, which is true,
instead of *"it's fine"*, which was not.

**4. Staleness is asymmetric, deliberately.** Prolonged `thinking` degrades to `stuck` —
because thinking forever is not a real state. A lingering `waiting_for_input` **does not
degrade**: a question that has gone unanswered for three hours is not stale information, it is
the most urgent thing on the screen, and aging it out would hide exactly what the system
exists to surface.

**5. Color is reserved.** The palette is committed to watcher states, and `waiting_for_input`
must remain the most salient element on screen. Coverage is signalled with **shape** (`⃠`), not
with a new color that would compete with the signal the operator needs to catch from across
the room.

## Consequences

**Good**

- Silence is only trusted when silence is information.
- The migration is additive and idempotent (`ALTER TABLE ... ADD COLUMN` behind a
  `PRAGMA table_info` check), because the database already existed in production on two hosts.
- The protocol extension is additive: `stateSince` flows watcher → server → UI, and an older
  consumer that ignores the field still works.
- `deriveCoverage` being pure meant the asymmetric-staleness rule could be tested exhaustively
  without a browser, a socket, or a clock.

**Costs accepted**

- More visual states to learn. A fourth rendering (`unknown`) is real cognitive load, paid
  once, in exchange for never being lied to.
- Sessions on hosts without the watcher deployed now *look* degraded. They are — the UI is
  reporting the truth about its own coverage, which was the point.

## Principle extracted

> A monitoring system must never report health it cannot observe. Reporting nothing is
> recoverable — the operator stays suspicious. Reporting false calm is not, because it
> actively suppresses the suspicion that would have caught the failure.
