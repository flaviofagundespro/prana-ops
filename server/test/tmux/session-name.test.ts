/**
 * Session-name allowlist tests (Story 1.3, AC2 / AC4 / AC10, Task 1).
 *
 * Covers:
 *  - buildSessionName produces the exact `ckpt-<projeto>-<assunto>-<n>` shape;
 *  - isCkptSession strictly accepts only the `ckpt-` prefix and REJECTS bypass
 *    attempts (`xckpt-`, `Ckpt-`, ` ckpt-`, empty string, non-strings);
 *  - assertCkptSession throws for forbidden names (the command-construction guard);
 *  - segment sanitization neutralizes shell-dangerous characters;
 *  - parseSessionName round-trips valid names and rejects malformed ones.
 */
import { describe, it, expect } from 'vitest';
import {
  CKPT_PREFIX,
  isCkptSession,
  assertCkptSession,
  sanitizeSegment,
  buildSessionName,
  parseSessionName,
} from '../../src/tmux/session-name.js';

describe('buildSessionName (AC1, AC2)', () => {
  it('produces the exact ckpt-<projeto>-<assunto>-<n> format', () => {
    // Story 2.12: o segmento do meio é o ASSUNTO, não o CLI.
    expect(buildSessionName('pranaops', 'watcher', 1)).toBe('ckpt-pranaops-watcher-1');
    expect(buildSessionName('proj', 'codex', 0)).toBe('ckpt-proj-codex-0');
  });

  it('lowercases and sanitizes shell-dangerous characters out of segments', () => {
    // Spaces, semicolons, backticks, slashes must not survive into the command.
    expect(buildSessionName('My Proj', 'cla ude', 2)).toBe('ckpt-my-proj-cla-ude-2');
    // Note: `-` is a safe char and is NOT collapsed, so the `-` from the space
    // plus the literal `-` in `-rf` yields `--` — the key point is that `;`,
    // spaces, and backticks never survive as shell metacharacters.
    expect(buildSessionName('a;rm -rf', 'x`whoami`', 3)).toBe('ckpt-a-rm--rf-x-whoami-3');
    // The result is always allowlisted and contains only [a-z0-9_-].
    const built = buildSessionName('a;rm -rf', 'x`whoami`', 3);
    expect(isCkptSession(built)).toBe(true);
    expect(built).toMatch(/^ckpt-[a-z0-9_-]+$/);
  });

  it('rejects a negative or non-integer index', () => {
    expect(() => buildSessionName('p', 'a', -1)).toThrow(/session index/);
    expect(() => buildSessionName('p', 'a', 1.5)).toThrow(/session index/);
    expect(() => buildSessionName('p', 'a', NaN)).toThrow(/session index/);
  });

  it('rejects a segment that sanitizes to empty', () => {
    expect(() => buildSessionName('***', 'agent', 1)).toThrow(/projeto/);
    expect(() => buildSessionName('proj', '!!!', 1)).toThrow(/assunto/);
  });

  it('Story 2.12/AC2: assunto vazio cai em `geral` — NUNCA no nome do agente', () => {
    // Foi o fallback antigo (agente) que produziu `ckpt-acme-claude-1` numa
    // sessão que roda Codex. Genérico e honesto > específico e errado.
    expect(buildSessionName('prana', '', 1)).toBe('ckpt-prana-geral-1');
    expect(buildSessionName('prana', '   ', 2)).toBe('ckpt-prana-geral-2');
    expect(buildSessionName('prana', undefined as unknown as string, 3)).toBe('ckpt-prana-geral-3');
  });
});

describe('isCkptSession — strict allowlist (AC4)', () => {
  it('accepts names with the exact ckpt- prefix', () => {
    expect(isCkptSession('ckpt-proj-claude-1')).toBe(true);
    expect(isCkptSession(CKPT_PREFIX + 'x')).toBe(true);
  });

  it('REJECTS bypass attempts and non-ckpt names', () => {
    expect(isCkptSession('xckpt-foo')).toBe(false); // does not START with prefix
    expect(isCkptSession('Ckpt-foo')).toBe(false); // wrong case
    expect(isCkptSession('CKPT-foo')).toBe(false); // wrong case
    expect(isCkptSession(' ckpt-foo')).toBe(false); // leading space (no implicit trim)
    expect(isCkptSession('\tckpt-foo')).toBe(false); // leading tab
    expect(isCkptSession('main')).toBe(false); // an unrelated user session
    expect(isCkptSession('4terminal')).toBe(false); // the user's manual session
    expect(isCkptSession('')).toBe(false); // empty
  });

  it('REJECTS non-string inputs without throwing', () => {
    expect(isCkptSession(undefined)).toBe(false);
    expect(isCkptSession(null)).toBe(false);
    expect(isCkptSession(42)).toBe(false);
    expect(isCkptSession({})).toBe(false);
  });
});

describe('assertCkptSession — the command-construction guard (AC4)', () => {
  it('does not throw for an allowlisted name', () => {
    expect(() => assertCkptSession('ckpt-proj-claude-1')).not.toThrow();
  });

  it('throws for any forbidden name (guards every tmux command builder)', () => {
    expect(() => assertCkptSession('main')).toThrow(/refusing to target non-ckpt/);
    expect(() => assertCkptSession('xckpt-evil')).toThrow(/refusing to target non-ckpt/);
    expect(() => assertCkptSession('')).toThrow(/refusing to target non-ckpt/);
  });
});

describe('sanitizeSegment', () => {
  it('collapses runs of unsafe chars to a single dash and trims edges', () => {
    expect(sanitizeSegment('  hello  world  ', 'projeto')).toBe('hello-world');
    expect(sanitizeSegment('a...b', 'projeto')).toBe('a-b');
    expect(sanitizeSegment('Keep_Underscore', 'agente')).toBe('keep_underscore');
  });

  it('throws when the segment reduces to empty', () => {
    expect(() => sanitizeSegment('   ', 'projeto')).toThrow(/empty session-name segment/);
    expect(() => sanitizeSegment('---', 'agente')).toThrow(/empty session-name segment/);
  });
});

describe('parseSessionName — best-effort adoption heuristic (AC3)', () => {
  it('round-trips a well-formed ckpt name', () => {
    expect(parseSessionName('ckpt-pranaops-claude-7')).toEqual({
      projeto: 'pranaops',
      assunto: 'claude',
      n: 7,
    });
  });

  it('returns null for non-ckpt or malformed names', () => {
    expect(parseSessionName('main')).toBeNull();
    expect(parseSessionName('ckpt-onlytwo')).toBeNull();
    expect(parseSessionName('ckpt-proj-agent-notanumber')).toBeNull();
    expect(parseSessionName('xckpt-proj-agent-1')).toBeNull();
  });
});
