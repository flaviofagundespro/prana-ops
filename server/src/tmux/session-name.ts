/**
 * tmux session name construction + the `ckpt-` allowlist guard (Story 1.3,
 * AC2 / AC4 / AC9).
 *
 * SECURITY INVARIANT: the cockpit may ONLY create, attach, pipe or kill tmux
 * sessions whose name matches the `ckpt-` grammar below. This is enforced as an ALLOWLIST at COMMAND-CONSTRUCTION time — not by
 * documentation or convention. Every function in this module that yields a tmux
 * command targeting a session name funnels through {@link assertCkptSession}, so
 * there is no code path that can build a tmux command against a non-`ckpt-`
 * session (a user's manual `4terminal.sh` / Tilix sessions stay untouched).
 *
 * This module is deliberately free of Node/network dependencies: it is pure
 * string logic so it can be unit-tested in isolation and reused by the
 * `TmuxSessionManager` and any command builder without pulling in the SSH layer.
 */

/** The one and only allowed session-name prefix. Case-sensitive, literal. */
export const CKPT_PREFIX = 'ckpt-';

/**
 * Full grammar of an acceptable session name: the literal prefix followed by one
 * or more characters that are inert in a shell — letters, digits, `_` and `-`.
 *
 * Uppercase is tolerated (never produced by {@link buildSessionName}, but a
 * session created by hand on the VPS may carry it, and adoption must not choke
 * on those). None of the accepted characters has meaning to `sh`.
 */
const SAFE_SESSION_NAME = /^ckpt-[A-Za-z0-9_-]+$/;

/**
 * Strict allowlist check: true ONLY when `name` matches {@link SAFE_SESSION_NAME}.
 *
 * Deliberately strict to defeat bypass attempts:
 *  - case-sensitive prefix (`Ckpt-`, `CKPT-` → false);
 *  - no implicit trim (`' ckpt-x'`, `'\tckpt-x'` → false);
 *  - a name that merely *contains* `ckpt-` but does not *start* with it
 *    (`xckpt-foo`) → false;
 *  - non-strings and the empty string → false;
 *  - **any shell metacharacter → false**.
 *
 * That last rule is the one this function was missing until 2026-07-30, and its
 * absence was a command-injection hole rather than a policy gap. The prefix
 * check alone accepted `ckpt-x; rm -rf ~; #`, which every command builder below
 * then interpolated into a shell string executed over SSH on the operator's
 * production host. The guard defended against *mistakes* (a caller targeting the
 * wrong session) and not against *input*, while the names it validates arrive
 * unfiltered from the WebSocket protocol.
 *
 * Quoting at the interpolation sites (see `session-manager.ts`) is the second
 * layer; this is the first. Neither is sufficient alone, because a future
 * builder may forget to quote and a future protocol field may bypass this.
 */
export function isCkptSession(name: unknown): name is string {
  return typeof name === 'string' && SAFE_SESSION_NAME.test(name);
}

/**
 * Wraps a value in single quotes for `sh`, escaping any embedded single quote
 * with the standard `'\''` dance. Inside single quotes `sh` expands nothing, so
 * the result is inert regardless of content.
 *
 * Used at every point where a value reaches a command string. Values that pass
 * {@link isCkptSession} need no quoting by construction — they are quoted anyway,
 * because defence that depends on a caller remembering an invariant is not
 * defence.
 */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Guard used by every command builder: throws if `name` is not an allowed
 * `ckpt-` session. Throwing (rather than returning) makes it impossible to
 * *accidentally* proceed — a caller that forgets to check still cannot emit a
 * command against a forbidden session, because the builder itself calls this.
 */
export function assertCkptSession(name: string): void {
  if (!isCkptSession(name)) {
    throw new Error(
      `refusing to target non-ckpt tmux session: ${JSON.stringify(name)} ` +
        `(only sessions with the "${CKPT_PREFIX}" prefix may be managed by the cockpit)`,
    );
  }
}

/**
 * Characters allowed in a session-name segment. tmux session names may not
 * contain `.` or `:` (they are structural in tmux target syntax) and we further
 * restrict to a shell-safe alphanumeric/`-`/`_` set so a `projeto`/`agente`
 * value can never break out of the intended `tmux` command or the `ckpt-`
 * pattern. Anything else is collapsed to `-`.
 */
const UNSAFE_SEGMENT_CHARS = /[^A-Za-z0-9_-]+/g;

/**
 * Sanitizes a single name segment (`projeto` or `assunto`): lowercases, replaces
 * any run of unsafe characters with a single `-`, and trims leading/trailing
 * `-`. Guarantees the result contains only `[a-z0-9_-]` so it cannot escape the
 * shell command or the `ckpt-<projeto>-<assunto>-<n>` shape.
 *
 * @throws if the segment reduces to an empty string (e.g. all-punctuation input),
 *   because an empty segment would produce an ambiguous / malformed session name.
 */
export function sanitizeSegment(raw: string, label: string): string {
  const cleaned = String(raw)
    .toLowerCase()
    .replace(UNSAFE_SEGMENT_CHARS, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) {
    throw new Error(`invalid ${label}: ${JSON.stringify(raw)} produced an empty session-name segment`);
  }
  return cleaned;
}

/** Story 2.12/AC2 — assunto vazio cai aqui, NUNCA no nome do agente. */
export const DEFAULT_ASSUNTO = 'geral';

/**
 * Builds the canonical session name `ckpt-<projeto>-<assunto>-<n>`.
 *
 * STORY 2.12: o segmento do meio era o AGENTE (o CLI). Isso fixou no nome a
 * ferramenta do momento — trocável dentro da mesma sessão — em vez da
 * identidade do trabalho. Na prática o nome mentiu: em 2026-07-27, duas sessões
 * chamadas `-claude-1` rodavam Codex. Projeto e assunto não mudam; o CLI muda.
 *
 * O nome importa porque é INTERFACE: o operador acessa as VPS do celular ou de
 * outro notebook, sem o cockpit, e ali só existe `tmux ls` + `tmux attach`.
 *
 * `assunto` vazio/ausente vira {@link DEFAULT_ASSUNTO} — jamais o agente (foi o
 * fallback antigo que produziu os `claude-1` enganosos).
 *
 * @throws if `n` is not a finite non-negative integer, or `projeto` is empty.
 */
export function buildSessionName(projeto: string, assunto: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid session index n: ${JSON.stringify(n)} (expected a non-negative integer)`);
  }
  const p = sanitizeSegment(projeto, 'projeto');
  // Assunto em branco não é erro (o operador pode não ter tema definido): cai
  // no default estável. sanitizeSegment lançaria — por isso o guard antes.
  const rawAssunto = String(assunto ?? '').trim();
  const a = rawAssunto.length > 0 ? sanitizeSegment(rawAssunto, 'assunto') : DEFAULT_ASSUNTO;
  const name = `${CKPT_PREFIX}${p}-${a}-${n}`;
  // Belt-and-suspenders: the constructed name MUST be allowlisted.
  assertCkptSession(name);
  return name;
}

/**
 * Best-effort inverse of {@link buildSessionName} used only for adopting existing
 * sessions (AC3): parses `ckpt-<projeto>-<assunto>-<n>` back into parts. Returns
 * `null` for any name that is not a `ckpt-` session or does not match the shape.
 *
 * This is a HEURISTIC for cache/metadata population, NEVER a source of truth —
 * an adopted session may have been named by an older cockpit version with a
 * different scheme, in which case the parts are simply `null`.
 */
export function parseSessionName(
  name: string,
): { projeto: string; assunto: string; n: number } | null {
  if (!isCkptSession(name)) return null;
  // SMK-014 (smoke E2E): sanitizeSegment PERMITE '-' interno ("Lumen-AI" →
  // "lumen-ia"), então <projeto> é greedy incluindo hífens; <assunto> é o
  // ÚLTIMO segmento simples antes de <n>. Se o assunto sanitizado contiver
  // hífen, o split é ambíguo — mas inofensivo para reabrir: buildSessionName
  // reconcatena as partes no MESMO nome exato.
  //
  // Story 2.12/AC3+AC4: nomes ANTIGOS (`ckpt-<projeto>-<agente>-<n>`) continuam
  // parseáveis — a forma é idêntica, só o SIGNIFICADO do meio mudou. E o campo
  // NUNCA deve alimentar `agent` no metadata: foi o nome ter mentido que
  // originou esta story. O agente real vem do processo no pane (2.11).
  const match = /^ckpt-([a-z0-9_-]+)-([a-z0-9_]+)-(\d+)$/.exec(name);
  if (!match) return null;
  return { projeto: match[1], assunto: match[2], n: Number(match[3]) };
}
