/**
 * ws profile:test-connection routing tests (Story 1.6, Task 5, AC3/AC10) and the
 * MNT-001 fix for history:request (Task 9, AC8).
 *
 * A fake ConnectionManager models the surface the handler uses (stateOf,
 * openChannel, closeChannel, connectionCount, channelCount, and the `state`
 * event). Covers:
 *  - already-connected profile → ok:true WITHOUT opening a channel (no 2nd conn);
 *  - disconnected profile that reaches `connected` → ok:true;
 *  - disconnected profile that reaches `error` → ok:false with a message;
 *  - timeout → ok:false;
 *  - MNT-001: history:request uses the OWNED channel's profileId, not the
 *    (adulterated) message.profileId.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../../src/ws/index.js';
import type { ConnectionManager } from '../../src/ssh/connection-manager.js';
import type { TmuxSessionManager } from '../../src/tmux/session-manager.js';

/**
 * Fake ConnectionManager. `openChannel` registers a channel and records the call;
 * `connectionCount`/`channelCount` let tests assert the 1-connection invariant.
 * `emitStateSoon` lets a test drive the async `state` event after openChannel.
 */
class FakeConnectionManager extends EventEmitter {
  openChannelCalls: string[] = [];
  closeChannelCalls: Array<{ profileId: string; channelId: string }> = [];
  private states = new Map<string, string>();
  private channels = new Map<string, Set<string>>();
  private seq = 0;

  setState(profileId: string, state: string): void {
    this.states.set(profileId, state);
  }
  stateOf(profileId: string): string | undefined {
    return this.states.get(profileId);
  }
  openChannel(profileId: string): string {
    this.openChannelCalls.push(profileId);
    if (!this.states.has(profileId)) this.states.set(profileId, 'connecting');
    if (!this.channels.has(profileId)) this.channels.set(profileId, new Set());
    const id = `${profileId}:${++this.seq}`;
    this.channels.get(profileId)!.add(id);
    return id;
  }
  closeChannel(profileId: string, channelId: string): void {
    this.closeChannelCalls.push({ profileId, channelId });
    this.channels.get(profileId)?.delete(channelId);
  }
  sendData(): void {}
  resizeChannel(): void {}
  connectionCount(): number {
    return this.states.size;
  }
  channelCount(profileId: string): number {
    return this.channels.get(profileId)?.size ?? 0;
  }
  /** Emit a `state` event on the next tick, simulating async connection progress. */
  emitStateSoon(profileId: string, state: string, delay = 5): void {
    setTimeout(() => {
      this.setState(profileId, state);
      this.emit('state', { profileId, state });
    }, delay);
  }
}

class FakeTmuxManager extends EventEmitter {
  captureCalls: Array<{ profileId: string; sessionName: string }> = [];
  async capturePane(profileId: string, sessionName: string): Promise<string> {
    this.captureCalls.push({ profileId, sessionName });
    return `captured ${sessionName}`;
  }
}

let server: http.Server | undefined;

function start(
  cm: FakeConnectionManager,
  opts: { tmux?: FakeTmuxManager; timeoutMs?: number } = {},
): Promise<{ server: http.Server; port: number }> {
  const s = http.createServer();
  attachWebSocketServer({
    server: s,
    path: '/ws',
    connectionManager: cm as unknown as ConnectionManager,
    tmuxManager: opts.tmux as unknown as TmuxSessionManager | undefined,
    ...(opts.timeoutMs !== undefined ? { testConnectionTimeoutMs: opts.timeoutMs } : {}),
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
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

describe('ws profile:test-connection routing (Story 1.6, AC3/AC10)', () => {
  it('already-connected profile → ok:true without opening a channel (no 2nd connection)', async () => {
    const cm = new FakeConnectionManager();
    cm.setState('1', 'connected');
    const started = await start(cm);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'profile:test-connection', profileId: '1' }));
    const res = await nextMessage(ws, 'profile:test-connection:result');

    expect(res.ok).toBe(true);
    expect(res.profileId).toBe('1');
    // No channel was opened for an already-connected profile.
    expect(cm.openChannelCalls).toHaveLength(0);
    expect(cm.channelCount('1')).toBe(0);
    ws.close();
  });

  it('disconnected profile reaching connected → ok:true, and closes only the test channel', async () => {
    const cm = new FakeConnectionManager();
    const started = await start(cm);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'profile:test-connection', profileId: '2' }));
    // Drive the connection to `connected` shortly after openChannel.
    cm.emitStateSoon('2', 'connected');

    const res = await nextMessage(ws, 'profile:test-connection:result');
    expect(res.ok).toBe(true);
    // Exactly one channel opened (the profile's single connection) and then closed.
    expect(cm.openChannelCalls).toEqual(['2']);
    expect(cm.closeChannelCalls).toHaveLength(1);
    expect(cm.channelCount('2')).toBe(0);
    // Still exactly one connection for the profile — never a second one.
    expect(cm.connectionCount()).toBe(1);
    ws.close();
  });

  it('disconnected profile reaching error → ok:false with a message', async () => {
    const cm = new FakeConnectionManager();
    const started = await start(cm);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'profile:test-connection', profileId: '3' }));
    cm.emitStateSoon('3', 'error');

    const res = await nextMessage(ws, 'profile:test-connection:result');
    expect(res.ok).toBe(false);
    expect(String(res.message)).toContain('error');
    expect(cm.closeChannelCalls).toHaveLength(1); // ephemeral test channel closed
    ws.close();
  });

  it('timeout with no state event → ok:false', async () => {
    const cm = new FakeConnectionManager();
    const started = await start(cm, { timeoutMs: 50 });
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'profile:test-connection', profileId: '4' }));
    // Never emit `connected` — let the 50ms timeout fire.
    const res = await nextMessage(ws, 'profile:test-connection:result');
    expect(res.ok).toBe(false);
    expect(String(res.message)).toContain('timed out');
    expect(cm.closeChannelCalls).toHaveLength(1);
    ws.close();
  });
});

describe('history:request MNT-001 (Story 1.6, AC8)', () => {
  it('captures with the OWNED channel profileId, not the client-supplied message.profileId', async () => {
    const cm = new FakeConnectionManager();
    const tmux = new FakeTmuxManager();
    const started = await start(cm, { tmux });
    server = started.server;
    const ws = await connect(started.port);

    // Open a channel on profile '1' so this socket OWNS a channel keyed to '1'.
    ws.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const openAck = await nextMessage(ws, 'channel:open');
    const channelId = String(openAck.channelId);

    // Send history:request with an ADULTERATED profileId ('999') — the handler
    // must ignore it and use the real owner ('1').
    ws.send(
      JSON.stringify({
        type: 'history:request',
        profileId: '999',
        channelId,
        sessionName: 'ckpt-a-claude-1',
      }),
    );
    await nextMessage(ws, 'history:result');

    expect(tmux.captureCalls).toHaveLength(1);
    expect(tmux.captureCalls[0].profileId).toBe('1'); // owned, NOT '999'
    expect(tmux.captureCalls[0].sessionName).toBe('ckpt-a-claude-1');
    ws.close();
  });
});
