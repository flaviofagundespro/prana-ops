# ADR 006 — Local is a transport, not localhost over SSH

## Context

Prana OPS originally modelled every environment as an SSH host. That made the operator's own
machine look like a special case: either require a local `sshd`, manufacture a key and user, or
create a parallel terminal path. All three choices add credentials or duplicate lifecycle logic
without improving the terminal experience.

Claude Code and Codex run locally as full-screen terminal applications. They need a real TTY and
resize events, while the existing tmux control commands need clean, non-echoed output.

## Decision

Profiles carry a `kind`: `ssh` or `local`. Existing rows migrate idempotently to `ssh`.

A composite connection manager routes a profile before it reaches the shared channel contract:

- SSH retains the existing bounded connection pool unchanged.
- Local interactive channels use `node-pty` and launch the operator's normal shell.
- Local control channels use child-process pipes without a TTY.

Both transports reuse the same WebSocket and `TmuxSessionManager` lifecycle. A channel remains
routed to the transport that opened it, so profile edits cannot redirect an active terminal.

## Consequences

The Settings UI can create a local environment with only a name. It does not ask for or save
fictional SSH credentials. Local use does not install or alter Claude Code, Codex, aliases,
SSH keys, or logins.

Closing a pane closes only the cockpit-owned PTY/process. The `ckpt-*` tmux session remains until
the operator explicitly deletes it. The native PTY dependency is lazy-loaded so unit tests using
doubles do not load it in parallel workers.
