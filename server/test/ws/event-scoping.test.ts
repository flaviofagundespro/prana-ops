/**
 * ws event scoping tests (AC8, ARCH-002): profile-scoped events
 * (`channel:state` / `channel:error`) must be forwarded ONLY to sockets that
 * actually own a channel on the event's profile. A socket that opened a channel
 * on profile A must NEVER receive state/error for profile B.
 *
 * Resolves the ARCH-002 finding carried from the Story 1.2/1.3 gates. A
 * lightweight fake ConnectionManager stands in for the SSH layer so the test
 * focuses purely on the bridge scoping logic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../../src/ws/index.js';
import type { ConnectionManager } from '../../src/ssh/connection-manager.js';

/** Fake manager that mints deterministic per-profile channelIds. */
class FakeManager extends EventEmitter {
  private seq = 0;
  openChannel(profileId: string): string {
    this.seq += 1;
    return `${profileId}:${this.seq}`;
  }
  sendData(): void {}
  resizeChannel(): void {}
  closeChannel(): void {}
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

function nextMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
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

/** Collects every message of `type` a socket receives during `windowMs`. */
function collect(ws: WebSocket, type: string, windowMs: number): Promise<Record<string, unknown>[]> {
  const received: Record<string, unknown>[] = [];
  const handler = (raw: WebSocket.RawData): void => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === type) received.push(msg);
  };
  ws.on('message', handler);
  return new Promise((resolve) => {
    setTimeout(() => {
      ws.off('message', handler);
      resolve(received);
    }, windowMs);
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('ws event scoping (ARCH-002)', () => {
  it('does NOT forward channel:state of profile B to a socket that only owns a channel on profile A', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;

    const wsA = await connect(started.port);
    const wsB = await connect(started.port);

    // Socket A opens a channel on profile '1'; socket B on profile '2'.
    wsA.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    await nextMessage(wsA, 'channel:open');
    wsB.send(JSON.stringify({ type: 'channel:open', profileId: '2' }));
    await nextMessage(wsB, 'channel:open');

    // Start collecting on B, then emit a state event for profile '1' (A's profile).
    const bStates = collect(wsB, 'channel:state', 250);
    const aStatePromise = nextMessage(wsA, 'channel:state');
    manager.emit('state', { profileId: '1', state: 'reconnecting' });

    const aState = await aStatePromise;
    const collectedByB = await bStates;

    expect(aState.profileId).toBe('1');
    expect(aState.state).toBe('reconnecting');
    // B owns no channel on profile '1' — it must receive nothing.
    expect(collectedByB).toHaveLength(0);

    wsA.close();
    wsB.close();
  });

  it('does NOT forward channel:error of profile B to a socket that only owns a channel on profile A', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;

    const wsA = await connect(started.port);
    const wsB = await connect(started.port);

    wsA.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    await nextMessage(wsA, 'channel:open');
    wsB.send(JSON.stringify({ type: 'channel:open', profileId: '2' }));
    await nextMessage(wsB, 'channel:open');

    const bErrors = collect(wsB, 'channel:error', 250);
    const aErrorPromise = nextMessage(wsA, 'channel:error');
    manager.emit('channelError', { profileId: '1', message: 'boom on profile 1' });

    const aError = await aErrorPromise;
    const collectedByB = await bErrors;

    expect(aError.profileId).toBe('1');
    expect(aError.message).toBe('boom on profile 1');
    expect(collectedByB).toHaveLength(0);

    wsA.close();
    wsB.close();
  });

  it('stops forwarding profile events after the socket closes its last channel on that profile', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;

    const wsA = await connect(started.port);
    wsA.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    const ack = await nextMessage(wsA, 'channel:open');
    const channelId = ack.channelId as string;

    // Close the only channel: the socket no longer owns profile '1'.
    wsA.send(JSON.stringify({ type: 'channel:close', channelId }));
    await new Promise((r) => setTimeout(r, 100));

    const aStates = collect(wsA, 'channel:state', 250);
    manager.emit('state', { profileId: '1', state: 'reconnecting' });
    const collected = await aStates;

    // No channels left on profile '1' → no state forwarded.
    expect(collected).toHaveLength(0);
    wsA.close();
  });

  it('drops a scopeless channel:error (no profileId, no channelId) for every socket', async () => {
    const manager = new FakeManager();
    const started = await start(manager);
    server = started.server;

    const wsA = await connect(started.port);
    wsA.send(JSON.stringify({ type: 'channel:open', profileId: '1' }));
    await nextMessage(wsA, 'channel:open');

    const aErrors = collect(wsA, 'channel:error', 250);
    manager.emit('channelError', { message: 'global unattributed error' });
    const collected = await aErrors;

    expect(collected).toHaveLength(0);
    wsA.close();
  });
});
