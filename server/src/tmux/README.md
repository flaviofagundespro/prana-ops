# tmux layer

Session management over the SSH channels from the transport layer. Implemented
in **`session-manager.ts`**, with naming rules and the allowlist guard in
**`session-name.ts`**.

> This file described a *placeholder* until 2026-07-30: it was written during
> scaffolding and never updated once the layer shipped. Corrected because a
> document claiming a directory is empty is worse than no document — it invites
> the reader to skip the code that actually runs.

## Scope

- tmux orchestration: `new-session -A`, `ls`, `capture-pane -e -p -S`,
  `pipe-pane`, `send-keys`
- attach-or-create, including adoption of sessions already present on the host
- continuous logging to `~/.cockpit/logs/<session>.log`, with automatic re-arming
  when the pipe dies (a `tmux-resurrect` restore drops it silently)
- periodic reconciliation of the session list against the host

## Security invariant

The cockpit may only create, attach to, pipe or kill sessions whose name matches
`^ckpt-[A-Za-z0-9_-]+$`, enforced as an **allowlist at command-construction
time** — every builder calls `assertCkptSession`. No code path can emit a tmux
command against a session the operator created by hand.

The grammar covers the whole name, not just the prefix, and every interpolated
value is shell-quoted. Until 2026-07-30 the check validated only the prefix,
which turned the session name into a command-injection vector — see
`docs/adr/005-untrusted-input-at-the-boundary.md`.
