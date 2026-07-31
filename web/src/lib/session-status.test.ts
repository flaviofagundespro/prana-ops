/**
 * toSidebarStatus tests (Story 1.6, Task 2, AC1). Pure function, no component.
 * resolveSessionStatus tests (Story 2.6, AC6): fusão liveness × watcher.
 */
import { describe, it, expect } from 'vitest';
import { toSidebarStatus, resolveSessionStatus } from './session-status.js';

describe('toSidebarStatus (AC1)', () => {
  it("maps 'active' to 'idle' (no output-reading signal in Phase 1)", () => {
    expect(toSidebarStatus('active')).toBe('idle');
  });

  it("maps 'error' to 'error' (reconciliation-flagged)", () => {
    expect(toSidebarStatus('error')).toBe('error');
  });
});

describe('resolveSessionStatus (Story 2.6, AC6)', () => {
  it('sessão viva COM estado do watcher → o estado do watcher (refina)', () => {
    expect(resolveSessionStatus('active', 'waiting_for_input')).toBe('waiting_for_input');
    expect(resolveSessionStatus('active', 'thinking')).toBe('thinking');
    expect(resolveSessionStatus('active', 'idle')).toBe('idle');
  });

  it('sessão viva SEM watcher → idle (Fase 1 exata — degradação, AC3)', () => {
    expect(resolveSessionStatus('active', undefined)).toBe('idle');
    expect(resolveSessionStatus('active')).toBe(toSidebarStatus('active'));
  });

  it('cache error (sumiu do tmux ls) SEMPRE vence — sessão morta não pensa (F9)', () => {
    expect(resolveSessionStatus('error', 'thinking')).toBe('error');
    expect(resolveSessionStatus('error', 'waiting_for_input')).toBe('error');
    expect(resolveSessionStatus('error', undefined)).toBe('error');
  });
});
