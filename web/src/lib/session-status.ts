/**
 * Sidebar status derivation (Story 1.6, Task 2, AC1).
 *
 * PRD F7 defines four UI states — `thinking` / `waiting_for_input` / `idle` /
 * `error` — with a Phase-1 heuristic ("output flowing → thinking; prompt →
 * waiting; silence → idle"). That finer heuristic requires per-session real-time
 * output reading OUTSIDE the active tile, which NO Phase-1 story implements and
 * which this story was not asked to build.
 *
 * The only REAL liveness signal available today is `session_metadata.status`
 * (`'active' | 'error'`), maintained by the Story 1.3 reconciliation loop. This
 * function maps that cache to the subset of F7 that is actually backed by data:
 *   - `'error'` → `'error'` (the session vanished / reconciliation flagged it);
 *   - `'active'` → `'idle'` (alive, but we cannot yet distinguish thinking vs
 *     waiting without an output-reading source).
 *
 * DELIBERATE SCOPE LIMIT (ratified @po 2026-07-13): `thinking` /
 * `waiting_for_input` are NOT invented here — surfacing them without a real
 * signal would be a fabrication (Constitution Article IV). Pure function, unit-
 * testable without any component.
 */

import type { WatcherSessionStateName } from '../ws-protocol.js';

/** The two liveness-cache states written by reconciliation (server contract). */
export type SessionCacheStatus = 'active' | 'error';

/** The subset of F7 UI states this story can honestly derive today. */
export type SidebarStatus = 'idle' | 'error';

export function toSidebarStatus(status: SessionCacheStatus): SidebarStatus {
  return status === 'error' ? 'error' : 'idle';
}

/**
 * Story 2.6 (AC6): funde o liveness da Fase 1 com o estado REAL do watcher.
 * A limitação documentada acima morreu — o sinal de leitura de output agora
 * existe (watcher, Stories 2.1–2.4) e chega PRONTO via `sessions:state`; o
 * app continua sem inferir nada (F9).
 *
 * Regra de fusão (o watcher REFINA, não substitui):
 *  - cache `error` (sessão sumiu do `tmux ls`) SEMPRE vence — sessão morta
 *    não está "pensando"; tmux segue sendo a fonte de "está viva" (F9);
 *  - sessão viva com estado do watcher → o estado do watcher;
 *  - sessão viva sem watcher (perfil degradado, AC3) → `idle` (Fase 1 exata).
 */
/**
 * ⚠️ Story 2.9: o `?? 'idle'` abaixo continua sendo o comportamento correto
 * para o ESTADO — mas ele não distingue "vigiada e calma" de "ninguém está
 * olhando". Essa distinção NÃO pertence a esta função (o estado é um eixo, a
 * cobertura é outro): vive em `session-coverage.ts`, e a UI exibe as duas.
 * Não tente codificar "sem sinal" como um valor de estado aqui — misturar os
 * eixos foi justamente o que fez o cockpit afirmar calma sem ter sinal.
 */
export function resolveSessionStatus(
  cacheStatus: SessionCacheStatus,
  watcherState?: WatcherSessionStateName,
): WatcherSessionStateName {
  if (cacheStatus === 'error') return 'error';
  return watcherState ?? 'idle';
}
