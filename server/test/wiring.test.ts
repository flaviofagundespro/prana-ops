/**
 * Connect-flow wiring tests (AC7, ARCH-003): `wireConnectionLifecycle` must
 * invoke `adoptExistingSessions` + `startReconciliation` exactly once per
 * `connected` transition and `stopReconciliation` on `closed`/`error`, without
 * duplicating loops across reconnects.
 *
 * Uses a real EventEmitter for the ConnectionManager state stream and vi.fn()
 * spies for the tmux lifecycle — no timers, no network, fully deterministic.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireConnectionLifecycle, type ReconciliationLifecycle } from '../src/wiring.js';
import type { ConnectionState } from '../src/ws/protocol.js';

/** Real emitter standing in for ConnectionManager's `state` stream. */
class FakeStateEmitter extends EventEmitter {
  emitState(profileId: string, state: ConnectionState): void {
    this.emit('state', { profileId, state });
  }
}

function makeTmux(): ReconciliationLifecycle & {
  adopt: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const adopt = vi.fn(async () => [] as string[]);
  const start = vi.fn();
  const stop = vi.fn();
  return {
    adopt,
    start,
    stop,
    adoptExistingSessions: adopt,
    startReconciliation: start,
    stopReconciliation: stop,
  };
}

describe('wireConnectionLifecycle (ARCH-003)', () => {
  it('adopts sessions and starts reconciliation exactly once on connected', async () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux });

    cm.emitState('7', 'connecting'); // no-op
    cm.emitState('7', 'connected');

    // Let the swallowed adoption promise settle.
    await Promise.resolve();

    expect(tmux.start).toHaveBeenCalledTimes(1);
    expect(tmux.start).toHaveBeenCalledWith('7');
    expect(tmux.adopt).toHaveBeenCalledTimes(1);
    expect(tmux.adopt).toHaveBeenCalledWith('7');
    expect(tmux.stop).not.toHaveBeenCalled();
  });

  it('does not duplicate loops across a reconnect (connected → reconnecting → connected)', async () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux });

    cm.emitState('7', 'connected');
    cm.emitState('7', 'reconnecting'); // must NOT stop the loop
    cm.emitState('7', 'connected');
    await Promise.resolve();

    // startReconciliation is invoked on each `connected` but is idempotent in the
    // real manager (returns early if a loop exists); wiring must never stop on
    // `reconnecting`.
    expect(tmux.stop).not.toHaveBeenCalled();
    expect(tmux.start).toHaveBeenCalledTimes(2);
    expect(tmux.start).toHaveBeenNthCalledWith(1, '7');
    expect(tmux.start).toHaveBeenNthCalledWith(2, '7');
  });

  it('stops reconciliation on closed and on error', () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux });

    cm.emitState('7', 'connected');
    cm.emitState('7', 'closed');
    expect(tmux.stop).toHaveBeenNthCalledWith(1, '7');

    cm.emitState('9', 'connected');
    cm.emitState('9', 'error');
    expect(tmux.stop).toHaveBeenNthCalledWith(2, '9');
  });

  it('scopes lifecycle per profile independently', async () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux });

    cm.emitState('1', 'connected');
    cm.emitState('2', 'connected');
    await Promise.resolve();

    expect(tmux.start).toHaveBeenCalledWith('1');
    expect(tmux.start).toHaveBeenCalledWith('2');
    expect(tmux.adopt).toHaveBeenCalledWith('1');
    expect(tmux.adopt).toHaveBeenCalledWith('2');
  });

  it('dirige o WatcherPoller pelo mesmo ciclo de vida (Story 2.6, AC2/AC3)', () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    const startPolling = vi.fn();
    const stopPolling = vi.fn();
    wireConnectionLifecycle({
      connectionManager: cm,
      tmuxManager: tmux,
      watcherPoller: { startPolling, stopPolling },
    });

    cm.emitState('7', 'connected');
    expect(startPolling).toHaveBeenCalledWith('7');

    // Reconexão NÃO para o poll (o backoff interno cuida da indisponibilidade).
    cm.emitState('7', 'reconnecting');
    expect(stopPolling).not.toHaveBeenCalled();

    cm.emitState('7', 'closed');
    expect(stopPolling).toHaveBeenCalledWith('7');
  });

  it('sem watcherPoller o wiring é EXATAMENTE o da Fase 1 (aditivo, sem crash)', () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux });

    // Transições completas sem poller — nada lança.
    cm.emitState('7', 'connected');
    cm.emitState('7', 'closed');
    expect(tmux.stop).toHaveBeenCalledWith('7');
  });

  it('swallows an adoptExistingSessions rejection (never crashes the process)', async () => {
    const cm = new FakeStateEmitter();
    const tmux = makeTmux();
    const failure = new Error('tmux ls timed out');
    tmux.adopt.mockRejectedValueOnce(failure);
    const onAdoptError = vi.fn();

    wireConnectionLifecycle({ connectionManager: cm, tmuxManager: tmux, onAdoptError });

    cm.emitState('7', 'connected');
    // Reconciliation still starts despite the adoption failure.
    expect(tmux.start).toHaveBeenCalledWith('7');

    await Promise.resolve();
    await Promise.resolve();
    expect(onAdoptError).toHaveBeenCalledWith('7', failure);
  });
});
