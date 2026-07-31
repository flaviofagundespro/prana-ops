# ADR 004 — A failed bind terminates the process; it is not a recoverable error

**Status:** Accepted · shipped
**Scope:** `server/src/index.ts`, `server/test/boot.test.ts`

## Context

The server installs a global `uncaughtException` handler that deliberately keeps the process
alive. That is a reasonable stance for a long-running operator tool: an async failure inside
one SSH profile should not take down every other session on the screen.

It is the wrong stance for a failure that happens **before there is anything to keep alive**.

When the port was already taken, the sequence was:

1. `listen()` fails with `EADDRINUSE`;
2. the error does **not** reach `server.on('error')`;
3. it lands in `uncaughtException`, which logs `[fatal]` and keeps the process running;
4. the process stays up forever, holding no port, serving nothing;
5. the success line — `[http] listening on ...` — is never printed.

The result is a ghost: a process that looks alive to `ps`, answers no requests, and writes a
fatal error into the log on every failed boot. Later diagnosis reads that log, finds a fatal
error, and draws conclusions from a corpse.

### Why `server.on('error')` never fired

`listen(port, host)` resolves the host first. Node performs a DNS lookup, and the
`EADDRINUSE` is **thrown inside that lookup's tick** rather than emitted on the server object.
The `error` handler — the one that would have called `process.exit(1)` — was unreachable for
the single failure mode it was written for.

### The premise that was wrong

The story that motivated this work asserted a **duplicate `listen()` call**: that the
WebSocket attachment bound the port and the explicit `listen()` then collided with it.

That was false, and it was written by the same person who later disproved it.

Instrumenting `net.Server.prototype.listen` showed exactly one call, succeeding.
(`new WebSocketServer({ server, path })` attaches an `upgrade` handler and binds nothing.)
The observed symptom was real; the mechanism named for it was invented.

A second wrong conclusion came from the same incident: it was decided that no duplicate
process existed. One did — inverted. The service-managed process held the port; the manually
launched one was the ghost, and the "restart" that had been announced never happened. The
health check returned 200 throughout, served by the process that was never restarted.

## Decision

**1. `EADDRINUSE` on `listen` exits the process.** One narrow branch inside the
`uncaughtException` handler, matched on both `code` and `syscall`:

```
[http] port N is already in use. Is the cockpit already running?
exit(1)
```

**2. The branch is deliberately narrow.** Every other `uncaughtException` still keeps the
process alive, including an async SSH failure during boot. The exception is for
*initialisation* failure specifically — there is no cockpit to preserve.

**3. `server.on('error')` stays, honestly documented.** It cannot see a `listen` failure. It
covers post-bind socket errors, and the comment now says so, instead of implying a coverage it
never had.

**4. A successful boot must print a success line.** This became the diagnostic rule of record:

> If `[http] listening on ...` is not in the log, that boot failed — regardless of whether
> something is answering on the port.

**5. Boot behaviour is tested by booting.** `boot.test.ts` spawns the real entrypoint on an
ephemeral port with a temporary database, asserts a clean boot prints the success line with no
fatal, then starts a second instance and asserts it reports the conflict, exits `1`, and does
**not** print the "keeping the process alive" message.

## Consequences

**Good**

- A failed boot is loud, immediate and self-explanatory.
- Logs stop accumulating fatal errors from boots that merely collided with a running instance.
- The distinction between "initialisation failed" and "runtime hiccup" is now explicit in code
  rather than implied.

**Costs accepted**

- A special case inside a general handler. Justified because the general handler's premise —
  *there is something worth keeping alive* — is false at boot, and the comment says exactly
  that.

## Principles extracted

> A global exception handler that keeps a process alive must not span initialisation. Before
> the service exists, there is nothing to protect, and "survive anything" turns a fast, obvious
> failure into a silent, permanent one.

> A log does not identify which process wrote it. Two instances, one healthy and one failing,
> produce a single interleaved narrative that reads like one machine contradicting itself.
> Verify the PID and the process start time — never the fact that something answered.

> Instrument before asserting a mechanism. A symptom being real does not make the explanation
> real, and a written-down explanation is believed far longer than a measured one.
