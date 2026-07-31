# SSH layer (Story 1.2)

The SSH transport layer for the Prana OPS. Implemented in
**`connection-manager.ts`**.

## Invariants

- **One connection per profile** (`profileId`), multiplexed into N shell channels
  (6 terminals = 1 connection, 6 channels), **until the server refuses a
  channel**. OpenSSH's `MaxSessions` caps channels per TCP connection (default
  10); on refusal the manager learns the observed ceiling and grows a bounded
  pool for that profile. Below the ceiling — the normal case — the behaviour is
  unchanged and `connectionCount()` stays 1.

  > Corrected 2026-07-30. This section used to state flatly that a channel
  > request "NEVER opens a second client", which stopped being true when the
  > pool shipped. See `docs/adr/003-ssh-channel-ceiling.md`.
- **Key-only auth**: the connect config uses `privateKey` read from the profile's
  `keyPath` (chmod 600 expected on disk). There is NO `password` under any path.
- **Keepalive active** (`keepaliveInterval`, default 10s).
- **Resilience**: a dropped connection triggers a single serial reconnect with
  exponential backoff (1s → 2s → 4s ... capped at 30s, max 10 attempts). On
  reconnect, all previously-open channels are reopened with the SAME channelIds.
  No SSH failure (connection or channel) crashes the process.
- **Server owns channelId**: `openChannel(profileId)` mints and returns the id
  (ratified ws contract — see `../ws/protocol.ts`).

## Out of scope for 1.2

- tmux sessions (`tmux new-session -A -s ckpt-*`) — Story 1.3, run OVER the shell
  channel this layer provides.
- Terminal grid / UI — Story 1.4.

## Manual verification (real VPS)

Automated tests use a mocked `ssh2` (no real network). To verify against a real
VPS manually:

1. Register a profile via the Story 1.1 profiles API (`POST /api/profiles` with
   `host`, `port`, `user`, `keyPath` pointing at a chmod-600 private key).
2. Connect a ws client to `/ws` and send `{ "type": "channel:open", "profileId": "<id>" }`.
3. Observe the `channel:open` ack carrying the server-minted `channelId`, then a
   `channel:state` `connected` event.
4. Open a second channel for the SAME profile and confirm (via `[ssh] profile ...`
   logs) that only ONE connection was established.
5. Send `channel:data` (e.g. `"ls\n"`) and observe shell output over `channel:data`.
6. Send `channel:resize` and confirm the remote `$COLUMNS`/`$LINES` change.
7. Drop the network (e.g. block the VPS) and observe `reconnecting` → `connected`
   with the channels reopened.
