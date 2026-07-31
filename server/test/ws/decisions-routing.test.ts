/**
 * ws decisions/watcher routing tests (Story 2.6, AC5/AC8): fake WatcherSyncSource
 * (nenhum poller/SSH real) valida que snapshots viram `decisions:update` +
 * `sessions:state` para os sockets, que um socket NOVO recebe o último snapshot
 * imediatamente, que `decisions:action` é roteada como PATCH e que payloads
 * malformados nunca chegam ao poller (parse rejeita). Também prova a
 * aditividade (AC8): o protocolo antigo segue intacto com o poller presente.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer, type WatcherSyncSource } from '../../src/ws/index.js';
import type { WatcherSnapshot } from '../../src/watcher/poller.js';

const SNAPSHOT: WatcherSnapshot = {
  profileId: '7',
  watcherAvailable: true,
  decisions: [
    {
      id: 3,
      sessionName: 'ckpt-prana-claude-1',
      summary: 'Aprovar deploy?',
      risk: 'high',
      status: 'pending',
      updatedAt: '2026-07-16 12:00:00.000',
    },
  ],
  states: [
    { sessionName: 'ckpt-prana-claude-1', state: 'waiting_for_input', updatedAt: '2026-07-16 12:00:00.000' },
  ],
};

class FakePoller extends EventEmitter implements WatcherSyncSource {
  snapshots: WatcherSnapshot[] = [];
  patchCalls: Array<{ profileId: string; decisionId: number; action: string }> = [];
  patchResult = true;

  lastSnapshots(): WatcherSnapshot[] {
    return this.snapshots;
  }
  patchDecision = vi.fn(async (profileId: string, decisionId: number, action: 'seen' | 'dismissed') => {
    this.patchCalls.push({ profileId, decisionId, action });
    return this.patchResult;
  });
  emitSnapshot(snapshot: WatcherSnapshot): void {
    this.emit('snapshot', snapshot);
  }
}

let server: http.Server | undefined;

function start(poller: FakePoller): Promise<{ server: http.Server; port: number }> {
  const s = http.createServer();
  attachWebSocketServer({ server: s, path: '/ws', watcherPoller: poller });
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve({ server: s, port });
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('ws watcher sync routing (Story 2.6)', () => {
  it('snapshot do poller vira decisions:update + sessions:state no socket (AC4/AC6/AC8)', async () => {
    const poller = new FakePoller();
    const started = await start(poller);
    server = started.server;
    const ws = await connect(started.port);

    const decisionsP = nextMessage(ws, 'decisions:update');
    const statesP = nextMessage(ws, 'sessions:state');
    poller.emitSnapshot(SNAPSHOT);

    const decisions = await decisionsP;
    expect(decisions.profileId).toBe('7');
    expect(decisions.watcherAvailable).toBe(true);
    expect(decisions.decisions).toEqual(SNAPSHOT.decisions);

    const states = await statesP;
    expect(states.states).toEqual(SNAPSHOT.states);
    ws.close();
  });

  it('socket NOVO recebe o último snapshot imediatamente (badge sem esperar poll)', async () => {
    const poller = new FakePoller();
    poller.snapshots = [SNAPSHOT];
    const started = await start(poller);
    server = started.server;

    // O snapshot chega COLADO no handshake — o listener precisa existir desde a
    // criação do socket, senão a mensagem se perde antes do await do 'open'.
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 100));

    const decisions = messages.find((m) => m.type === 'decisions:update');
    expect(decisions?.profileId).toBe('7');
    expect((decisions?.decisions as unknown[]).length).toBe(1);
    expect(messages.some((m) => m.type === 'sessions:state')).toBe(true);
    ws.close();
  });

  it('decisions:action roteia para patchDecision com os campos validados (AC5)', async () => {
    const poller = new FakePoller();
    const started = await start(poller);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'decisions:action', profileId: '7', decisionId: 3, action: 'dismissed' }));
    await new Promise((r) => setTimeout(r, 100));

    expect(poller.patchCalls).toEqual([{ profileId: '7', decisionId: 3, action: 'dismissed' }]);
    ws.close();
  });

  it('decisions:action malformada (id não-inteiro / action fora da allowlist) é rejeitada no parse', async () => {
    const poller = new FakePoller();
    const started = await start(poller);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'decisions:action', profileId: '7', decisionId: 3.5, action: 'seen' }));
    const err1 = await nextMessage(ws, 'error');
    expect(String(err1.message)).toContain('unknown or malformed');

    ws.send(JSON.stringify({ type: 'decisions:action', profileId: '7', decisionId: 3, action: 'answered' }));
    const err2 = await nextMessage(ws, 'error');
    expect(String(err2.message)).toContain('unknown or malformed');

    expect(poller.patchCalls).toEqual([]);
    ws.close();
  });

  it('PATCH que falha no watcher vira decisions:error (nunca crash)', async () => {
    const poller = new FakePoller();
    poller.patchResult = false;
    const started = await start(poller);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'decisions:action', profileId: '7', decisionId: 3, action: 'seen' }));
    const err = await nextMessage(ws, 'decisions:error');
    expect(err.profileId).toBe('7');
    expect(err.decisionId).toBe(3);
    ws.close();
  });

  it('sem watcherPoller, decisions:action responde decisions:error (aditivo, sem crash)', async () => {
    const s = http.createServer();
    attachWebSocketServer({ server: s, path: '/ws' });
    const port = await new Promise<number>((resolve) => {
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
    });
    server = s;
    const ws = await connect(port);

    ws.send(JSON.stringify({ type: 'decisions:action', profileId: '7', decisionId: 3, action: 'seen' }));
    const err = await nextMessage(ws, 'decisions:error');
    expect(String(err.message)).toContain('unavailable');
    ws.close();
  });
});
