import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { initDatabase } from '../../src/db/schema.js';
import { createApp } from '../../src/http/app.js';

let server: http.Server | undefined;

async function start(): Promise<number> {
  const app = createApp({ db: initDatabase(':memory:') });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function request(port: number, method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

afterEach(() => { server?.close(); server = undefined; });

describe('local profiles API', () => {
  it('creates a local Ryzen profile without SSH credentials', async () => {
    const port = await start();
    const response = await request(port, 'POST', '/api/profiles', { kind: 'local', name: 'Ryzen' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ kind: 'local', name: 'Ryzen', host: '', user: '', keyPath: '' });
  });

  it('still requires credentials for an SSH profile', async () => {
    const port = await start();
    const response = await request(port, 'POST', '/api/profiles', { kind: 'ssh', name: 'Azure' });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toMatch(/host, user and keyPath/);
  });
});
