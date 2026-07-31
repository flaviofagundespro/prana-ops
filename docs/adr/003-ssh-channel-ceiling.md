# ADR 003 — Learn the SSH channel ceiling at runtime; pool connections per host

**Status:** Accepted · shipped
**Scope:** `server/src/ssh/connection-manager.ts`, `web/src/components/TerminalTile.tsx`

## Context

The cockpit multiplexes every terminal for a host over **one** SSH connection, as N channels.
That is the right default: opening a channel on a live connection is fast, and holding one TCP
connection per host is cheap.

One morning, sessions on the busiest host stopped opening. Clicking a session did nothing —
no error, no spinner, no log line. Meanwhile:

- the SSH connection was `ESTAB`;
- `/health` returned 200;
- **`ssh <host>` from a terminal worked perfectly.**

That last fact is what made the diagnosis expensive. It reads as proof that the server is fine
and the application is broken, and it cost a morning and two wrong hypotheses — including a
hunt for a phantom process holding the HTTP port.

### The actual cause

OpenSSH's `MaxSessions` limits **channels inside one TCP connection**, not connections. The
default is 10. The busy host had 10 sessions open, so the connection was full, and every new
`shell()` was refused with `CHANNEL_OPEN_FAILURE`.

`ssh <host>` from a terminal kept working because it opens a **new connection with its own
counter**. Both facts were true simultaneously. The evidence that felt most decisive was the
evidence that mattered least.

### The second cause, which was worse

The server had been detecting the refusal and emitting a `channel:error` event the whole time.
The protocol carried it. The front end had a `switch` over incoming messages with a
`default: return`, and no case for it.

> Detection was not missing. Transport was not missing. **A listener was missing.**

The invisibility that cost the morning was six lines of front-end code.

## Decision

**1. A pool per host, not a connection per host.** The manager holds a pool; below saturation
the pool contains exactly one connection, which preserves the original design for the normal
case.

**2. The ceiling is learned, never hardcoded.** On refusal, the manager counts how many
channels with a **live stream** coexisted at that moment and records that as the observed
ceiling for the host. `10` is only a default — one host in this deployment runs `60`. A
hardcoded number would be wrong somewhere by construction.

**3. A refusal with zero live channels is not a ceiling.** Learning `ceiling = 0` would
permanently wedge the host: no channel would ever fit. Refusals under that condition are
treated as ordinary errors.

**4. The refused channel is relocated, not failed.** The channel record keeps its ID and moves
to another connection, so the caller's ID stays valid and data routing never notices. Exactly
one relocation is attempted; a channel that is refused twice is a real error, not congestion.

**5. Control channels get a reserve.** Session channels may use `ceiling - 2`; control channels
may use the full ceiling. Bookkeeping commands must not be starved by terminal windows, and
they are short-lived.

**6. The operator is told, in text, once per discovery.** The tile prints what happened, the
number it can verify on the host, and what the cockpit is doing about it. Repeated saturation
does not repeat the message — a warning that fires every time becomes noise and stops being
read.

**7. No new color.** The message is emphasis-weighted, not colored: the palette belongs to
agent state, and `waiting_for_input` must stay the most salient thing on screen (see ADR 001).

### Measured trade-off

| Operation | Cost |
|---|---|
| New SSH connection (full handshake) | ~1.8 s |
| New channel on an existing connection | ~0.27 s |

~7× slower. This is why the pool grows only under refusal, and never speculatively.

## Consequences

**Good**

- Saturation degrades into a slightly slower session plus one explanatory line, instead of
  silence.
- The ceiling adapts per host with no configuration.
- Nine tests reproduce saturation with a client that refuses `shell()` past N channels the way
  `sshd` does — including the zero-regression case (below the ceiling: one connection, nothing
  learned, no warnings) and the guarantee that existing streams are never torn down.

**Costs accepted**

- More TCP connections to a saturated host, which counts against `MaxStartups`. Acceptable:
  the growth is bounded by demand and only happens after a refusal.
- The ceiling is learned per process. A restart forgets it and must re-learn on the next
  refusal — one extra warning, no incorrect behaviour.

## Principle extracted

> When a manual command succeeds and the application fails against the same server, the
> difference is usually **shared state the manual command does not share**. The evidence that
> feels most decisive — "I just did it by hand, it works" — is the evidence most likely to be
> answering a different question than the one you asked.

And, separately:

> An error that is detected, serialized and transmitted but never rendered is
> indistinguishable from an error that was never detected. Wire the listener first; the
> detection is worthless without it.
