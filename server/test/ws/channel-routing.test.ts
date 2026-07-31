/**
 * ws channel routing tests (AC9, AC10): the ws server routes channel:* messages
 * to the ConnectionManager and replies with the server-minted channelId ack. A
 * lightweight fake manager stands in for the real SSH layer (which has its own
 * mocked-ssh2 tests) so this test focuses purely on the transport wiring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../../src/ws/index.js';
import type { ConnectionManager } from '../../src/ssh/connection-manager.js';

/** Records calls so the test can assert routing. */
class FakeManager extends EventEmitter {
  opened: string[] = [];
  sent: Array<{ channelId: string; data: string }> = [];
  resized: Array<{ channelId: string; cols: number; rows: number }> = [];
  closed: Array<{ channelId: string; reason?: string }> = [];
  private seq = 0;

  openChannel(profileId: string): string {
    this.opened.push(profileId);
    this.seq += 1;
    return `${profileId}:${this.seq}`;
  }
  sendData(_p: string, channelId: string, data: string): void {
    this.sent.push({ channelId, data });
  }
  resizeChannel(_p: string, channelId: string, cols: number, rows: number): void {
    this.resized.push({ channelId, cols, rows });
  }
  closeChannel(_p: string, channelId: string, reason?: string): void {
    this.closed.push({ channelId, reason });
  }
}

let server: http.Server | undefined;

function start(manager: FakeManager): Promise<{ server: http.Server; port: number }> {
  const s = http.createServer();
  attachWebSocketServer({
    server: s,
    path: '/ws',
    connectionManager: manager as unknown as ConnectionManager,
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

/** Waits for the next message of a given type. */
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

describe('ws channel routing', () => {
  it('acks channel:open with a SERVER-MINTED channelId (ratified contract)', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const ack = await nextMessage(ws, 'channel:open');

    expect(ack.profileId).toBe('1');
    expect(typeof ack.channelId).toBe('string');
    expect(manager.opened).toEqual(['1']);
    ws.close();
  });

  it('routes data, resize, and close using the acked channelId', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const ack = await nextMessage(ws, 'channel:open');
    const channelId = ack.channelId as string;

    ws.send(JSON.stringify({ type: 'channel:data', channelId, data: 'whoami\n' }));
    ws.send(JSON.stringify({ type: 'channel:resize', channelId, cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: 'channel:close', channelId, reason: 'user' }));

    // Give the server a tick to process.
    await new Promise((r) => setTimeout(r, 100));

    expect(manager.sent).toEqual([{ channelId, data: 'whoami\n' }]);
    expect(manager.resized).toEqual([{ channelId, cols: 100, rows: 30 }]);
    expect(manager.closed).toEqual([{ channelId, reason: 'user' }]);
    ws.close();
  });

  it('forwards manager data/state events to the owning socket', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const ack = await nextMessage(ws, 'channel:open');
    const channelId = ack.channelId as string;

    const dataPromise = nextMessage(ws, 'channel:data');
    manager.emit('data', { profileId: '1', channelId, data: Buffer.from('output') });
    const dataMsg = await dataPromise;
    expect(dataMsg.data).toBe('output');

    const statePromise = nextMessage(ws, 'channel:state');
    manager.emit('state', { profileId: '1', state: 'reconnecting' });
    const stateMsg = await statePromise;
    expect(stateMsg.state).toBe('reconnecting');
    ws.close();
  });

  it('still answers legacy ping/pong (backward compatible with Story 1.1)', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await nextMessage(ws, 'pong');
    expect(pong.type).toBe('pong');
    ws.close();
  });

  it('rejects malformed messages with an error frame (never crashes)', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;
    const ws = await connect(started.port);

    ws.send(JSON.stringify({ type: 'channel:bogus' }));
    const err = await nextMessage(ws, 'error');
    expect(String(err.message)).toContain('unknown or malformed');
    ws.close();
  });
});
