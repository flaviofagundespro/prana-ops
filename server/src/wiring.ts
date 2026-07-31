/**
 * Testable connect-flow wiring (Story 1.4, ARCH-003).
 *
 * The backend entrypoint `index.ts` has process-level side effects (opens
 * SQLite, binds the HTTP port, calls `process.exit`) that make its wiring
 * impossible to unit-test in isolation. This module extracts the ONE piece that
 * needs deterministic testing — bridging `ConnectionManager` state transitions
 * to the `TmuxSessionManager` lifecycle — into a pure function that takes both
 * managers and registers the listener.
 *
 * ARCH-003 (finding carried from the Story 1.3 gate): `adoptExistingSessions`
 * and `startReconciliation` were implemented + tested but never invoked at
 * runtime. This wiring invokes them on the `connected` transition and stops
 * reconciliation on `closed`/`error`, with idempotency across reconnects.
 *
 * No new SSH connection and no `TmuxSessionManager` extension are introduced —
 * `stopReconciliation(profileId)` already exists (session-manager.ts:295) and
 * `startReconciliation` is already idempotent per profile (returns early if a
 * loop is active). We only CONSUME the existing granular API.
 */
import type { ConnectionState } from './ws/protocol.js';

/** Minimal ConnectionManager surface this wiring depends on (state events only). */
export interface StateEmitter {
  on(event: 'state', listener: (payload: { profileId: string; state: ConnectionState }) => void): unknown;
}

/** Minimal TmuxSessionManager surface this wiring drives (ARCH-003). */
export interface ReconciliationLifecycle {
  adoptExistingSessions(profileId: string): Promise<string[]>;
  startReconciliation(profileId: string): void;
  stopReconciliation(profileId: string): void;
}

/** Superfície mínima do WatcherPoller que o wiring dirige (Story 2.6, AC2/AC3). */
export interface WatcherPollLifecycle {
  startPolling(profileId: string): void;
  stopPolling(profileId: string): void;
}

/**
 * Registers the connect-flow bridge: on `state === 'connected'` for a profile,
 * adopt existing `ckpt-*` sessions and start the reconciliation loop; on
 * `closed`/`error`, stop that profile's loop.
 *
 * Idempotency: `startReconciliation` no-ops if a loop is already active for the
 * profile, and `adoptExistingSessions` only inserts metadata for sessions it
 * does not already know, so repeated `connected` transitions (reconnects) never
 * duplicate loops nor re-adopt. `adoptExistingSessions` rejection is swallowed
 * (logged via `onAdoptError`) so a transient `tmux ls` failure never crashes the
 * process — reconciliation still starts and will catch up on the next tick.
 */
export function wireConnectionLifecycle(deps: {
  connectionManager: StateEmitter;
  tmuxManager: ReconciliationLifecycle;
  /**
   * Story 2.6 (AC2/AC3): poller do watcher, dirigido pelo MESMO ciclo de vida
   * da reconciliação — começa em `connected`, para em `closed`/`error` (o
   * backoff de indisponibilidade do watcher é interno ao poller; parar aqui é
   * o que evita brigar com a lógica de reconexão da Fase 1). Opcional e
   * aditivo: sem poller, o wiring é EXATAMENTE o da Fase 1.
   */
  watcherPoller?: WatcherPollLifecycle;
  /** Optional hook for adoption failures (defaults to a console.warn). */
  onAdoptError?: (profileId: string, error: unknown) => void;
}): void {
  const { connectionManager, tmuxManager, watcherPoller } = deps;
  const onAdoptError =
    deps.onAdoptError ??
    ((profileId: string, error: unknown): void => {
      console.warn(
        `[tmux] adoptExistingSessions failed for profile ${profileId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

  connectionManager.on('state', ({ profileId, state }) => {
    if (state === 'connected') {
      // Start the reconciliation loop first (idempotent) so liveness tracking is
      // active even if adoption momentarily fails.
      tmuxManager.startReconciliation(profileId);
      // Story 2.6: idem para o poller do watcher (startPolling é idempotente).
      watcherPoller?.startPolling(profileId);
      void tmuxManager.adoptExistingSessions(profileId).catch((error: unknown) => {
        onAdoptError(profileId, error);
      });
    } else if (state === 'closed' || state === 'error') {
      // Reconnection ('reconnecting') keeps the loop running; only a definitive
      // close/error tears it down.
      tmuxManager.stopReconciliation(profileId);
      watcherPoller?.stopPolling(profileId);
    }
  });
}
