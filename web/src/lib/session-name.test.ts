/**
 * parseSessionName mirror tests (Story 1.6, Task 6, AC7). Pure function; asserts
 * parity with the canonical server parser for the shapes UX-001 relies on.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionName } from './session-name.js';

describe('parseSessionName mirror (AC7)', () => {
  it('parses ckpt-<projeto>-<assunto>-<n> into parts', () => {
    expect(parseSessionName('ckpt-outroprojeto-codex-2')).toEqual({
      projeto: 'outroprojeto',
      assunto: 'codex',
      n: 2,
    });
  });

  it('parses segments with underscores and digits', () => {
    expect(parseSessionName('ckpt-my_proj-claude_2-10')).toEqual({
      projeto: 'my_proj',
      assunto: 'claude_2',
      n: 10,
    });
  });

  it('returns null for a non-ckpt name', () => {
    expect(parseSessionName('my-old-session')).toBeNull();
  });

  it('returns null for a ckpt name outside the canonical shape', () => {
    expect(parseSessionName('ckpt-onlyoneseg')).toBeNull();
    expect(parseSessionName('ckpt-a-b-notanumber')).toBeNull();
  });
});
