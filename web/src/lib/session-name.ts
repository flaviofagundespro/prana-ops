/**
 * Frontend MIRROR of `server/src/tmux/session-name.ts` `parseSessionName`
 * (Story 1.6, Task 6, AC7).
 *
 * CANONICAL SOURCE: `server/src/tmux/session-name.ts` (lines 110-119). `web/` and
 * `server/` are isolated tsconfig roots (DOM vs Node lib targets), so the frontend
 * cannot import server code directly — the same reason `ws-protocol.ts` is a hand-
 * kept mirror. This is a DELIBERATE, DOCUMENTED mirror of the pure regex logic,
 * NOT a divergent reimplementation. If the canonical parser changes, change it in
 * the server file first, then update this mirror.
 *
 * Used to resolve UX-001: when the user clicks "Reabrir {name}", the target
 * project/agent/n must be DERIVED FROM THE CLICKED NAME, not from the current form
 * fields (which may have drifted). Returns `null` for any name outside the
 * `ckpt-<projeto>-<assunto>-<n>` shape (e.g. sessions adopted under an older
 * convention), in which case the caller falls back to the form values.
 */

/** The one and only allowed session-name prefix (mirror of CKPT_PREFIX). */
const CKPT_PREFIX = 'ckpt-';

function isCkptSession(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(CKPT_PREFIX);
}

/**
 * Best-effort inverse of the canonical `buildSessionName`. Parses
 * `ckpt-<projeto>-<assunto>-<n>` back into parts. Returns `null` for any name that
 * is not a `ckpt-` session or does not match the shape.
 */
export function parseSessionName(
  name: string,
): { projeto: string; assunto: string; n: number } | null {
  if (!isCkptSession(name)) return null;
  // SMK-014: projeto greedy com hífens (mirror do canônico) — "Lumen-AI"
  // sanitiza para "lumen-ia" e o parse antigo retornava null, fazendo o
  // clique na sidebar ser descartado em silêncio.
  const match = /^ckpt-([a-z0-9_-]+)-([a-z0-9_]+)-(\d+)$/.exec(name);
  if (!match) return null;
  return { projeto: match[1], assunto: match[2], n: Number(match[3]) };
}
