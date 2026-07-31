/**
 * Smoke tests (AC7):
 *  - the backend boots (HTTP health check responds),
 *  - the WebSocket server accepts a connection and answers a ping.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { initDatabase } from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import { attachWebSocketServer } from '../src/ws/index.js';

let server: http.Server | undefined;

function startServer(): Promise<{ server: http.Server; port: number }> {
  const db = initDatabase(':memory:');
  const app = createApp({ db });
  const s = http.createServer(app);
  attachWebSocketServer({ server: s, path: '/ws' });
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve({ server: s, port });
    });
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('backend smoke', () => {
  it('boots and responds on /api/health', async () => {
    const started = await startServer();
    server = started.server;

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${started.port}/api/health`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });

    const json = JSON.parse(body);
    expect(json.status).toBe('ok');
    expect(json.service).toBe('prana-ops');
  });

  it('accepts a WebSocket connection and answers ping', async () => {
    const started = await startServer();
    server = started.server;

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`);
      const timeout = setTimeout(() => reject(new Error('ws timeout')), 3000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'pong') {
          clearTimeout(timeout);
          ws.close();
          resolve('pong');
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(reply).toBe('pong');
  });
});
