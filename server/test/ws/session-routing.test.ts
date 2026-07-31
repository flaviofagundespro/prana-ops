/**
 * ws session:* routing tests (Story 1.3, AC1/AC3, Task 8).
 *
 * Verifies the additive `session:*` layer above the ratified `channel:*` contract:
 *  - session:create → server-minted sessionName + channelId (ratified @po);
 *  - session:list → list of ckpt-* sessions;
 *  - session:create when no tmux manager is wired → session:error (never crashes).
 *
 * A fake TmuxSessionManager stands in (the real one has its own unit tests) so
 * this test focuses purely on the ws routing + envelope shape.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../../src/ws/index.js';
import type { ConnectionManager } from '../../src/ssh/connection-manager.js';
import type { TmuxSessionManager } from '../../src/tmux/session-manager.js';

class FakeConnectionManager extends EventEmitter {
  openChannel(profileId: string): string {
    return `${profileId}:1`;
  }
  sendData(): void {}
  resizeChannel(): void {}
  closeChannel(): void {}
}

class FakeTmuxManager extends EventEmitter {
  createCalls: Array<{ profileId: string; projeto: string; agente: string; n: number; agenda?: string | null }> = [];
  nextSessionIndex(): number {
    return 5;
  }
  createOrAttach(
    profileId: string,
    projeto: string,
    agente: string,
    n: number,
    extra?: { agenda?: string | null },
  ): { sessionName: string; channelId: string } {
    this.createCalls.push({ profileId, projeto, agente, n, agenda: extra?.agenda });
    return { sessionName: `ckpt-${projeto}-${agente}-${n}`, channelId: `${profileId}:1` };
  }
  async listCkptSessions(_profileId: string): Promise<string[]> {
    return ['ckpt-a-claude-1', 'ckpt-b-codex-2'];
  }
  captureCalls: Array<{ profileId: string; sessionName: string }> = [];
  async capturePane(profileId: string, sessionName: string): Promise<string> {
    this.captureCalls.push({ profileId, sessionName });
    return `[32mcaptured history for ${sessionName}[0m\n`;
  }
}

let server: http.Server | undefined;

function start(tmux?: FakeTmuxManager): Promise<{ server: http.Server; port: number }> {
  const s = http.createServer();
  attachWebSocketServer({
    server: s,
    path: '/ws',
    connectionManager: new FakeConnectionManager() as unknown as ConnectionManager,
    tmuxManager: tmux as unknown as TmuxSessionManager | undefined,
  });
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

describe('ws session:* routing (Story 1.3)', () => {
  it('acks session:create with server-minted sessionName + channelId (ratified)', async () => {
    const tmux = new FakeTmuxManager();
    const started = await start(tmux);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(
      JSON.stringify({
        type: 'session:create',
        profileId: '1',
        projeto: 'pranaops',
        pauta: 'ship 1.3',
        agente: 'claude',
      }),
    );
    const ack = await nextMessage(ws, 'session:created');

    expect(ack.profileId).toBe('1');
    expect(ack.sessionName).toBe('ckpt-pranaops-claude-5'); // n defaulted via nextSessionIndex
    expect(typeof ack.channelId).toBe('string');
    // The pauta was forwarded as agenda.
    expect(tmux.createCalls[0].agenda).toBe('ship 1.3');
    ws.close();
  });

  it('honors an explicit n in session:create', async () => {
    const tmux = new FakeTmuxManager();
    const started = await start(tmux);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(
      JSON.stringify({
        type: 'session:create',
        profileId: '1',
        projeto: 'proj',
        pauta: 'p',
        agente: 'codex',
        n: 3,
      }),
    );
    const ack = await nextMessage(ws, 'session:created');
    expect(ack.sessionName).toBe('ckpt-proj-codex-3');
    ws.close();
  });

  it('returns the list of ckpt-* sessions for session:list', async () => {
    const tmux = new FakeTmuxManager();
    const started = await start(tmux);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'session:list', profileId: '1' }));
    const res = await nextMessage(ws, 'session:list');
    expect(res.sessions).toEqual(['ckpt-a-claude-1', 'ckpt-b-codex-2']);
    ws.close();
  });

  it('history:request captures the session and acks history:result (Story 1.5, AC1)', async () => {
    const tmux = new FakeTmuxManager();
    const started = await start(tmux);
    server = started.server;
    const ws = await connect(started.port);

    // Open a channel first so this socket OWNS the channelId (ARCH-002 scoping).
    ws.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const openAck = await nextMessage(ws, 'channel:open');
    const channelId = String(openAck.channelId);

    ws.send(
      JSON.stringify({ type: 'history:request', profileId: '1', channelId, sessionName: 'ckpt-a-claude-1' }),
    );
    const result = await nextMessage(ws, 'history:result');

    expect(result.channelId).toBe(channelId);
    expect(String(result.data)).toContain('captured history for ckpt-a-claude-1');
    expect(tmux.captureCalls[0]).toEqual({ profileId: '1', sessionName: 'ckpt-a-claude-1' });
    ws.close();
  });

  it('history:request for a channelId this socket does NOT own is rejected (AC5, ARCH-002)', async () => {
    const tmux = new FakeTmuxManager();
    const started = await start(tmux);
    server = started.server;
    const ws = await connect(started.port);

    // No channel:open first — the socket owns no channels, so this must be rejected.
    ws.send(
      JSON.stringify({ type: 'history:request', profileId: '1', channelId: 'not-mine', sessionName: 'ckpt-a-claude-1' }),
    );
    const err = await nextMessage(ws, 'history:error');
    expect(err.channelId).toBe('not-mine');
    expect(String(err.message)).toContain('unknown channel');
    // capturePane was never called for an unowned channel.
    expect(tmux.captureCalls).toHaveLength(0);
    ws.close();
  });

  it('history:request replies history:error when no tmux manager is wired (never crashes)', async () => {
    const started = await start(undefined); // no tmux manager
    server = started.server;
    const ws = await connect(started.port);

    ws.send(
      JSON.stringify({ type: 'history:request', profileId: '1', channelId: 'c1', sessionName: 'ckpt-a-claude-1' }),
    );
    const err = await nextMessage(ws, 'history:error');
    expect(err.channelId).toBe('c1');
    expect(String(err.message)).toContain('tmux manager unavailable');
    ws.close();
  });

  it('replies session:error when no tmux manager is wired (never crashes)', async () => {
    const started = await start(undefined); // no tmux manager
    server = started.server;
    const ws = await connect(started.port);

    ws.send(
      JSON.stringify({
        type: 'session:create',
        profileId: '1',
        projeto: 'p',
        pauta: 'x',
        agente: 'claude',
      }),
    );
    const err = await nextMessage(ws, 'session:error');
    expect(String(err.message)).toContain('tmux manager unavailable');
    ws.close();
  });
});
