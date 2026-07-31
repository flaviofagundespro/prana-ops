/**
 * PATCH /api/sessions/:id (label) + DELETE /api/sessions/:id (Story 1.7).
 *
 * Cobre: editar/limpar o label (só exibição — não renomeia a sessão tmux);
 * delete invoca onSessionDelete (kill do tmux na VPS) ANTES de remover os
 * metadados; delete sem callback remove só os metadados; 404 para id
 * desconhecido; 502 quando o kill remoto falha (metadados preservados).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { initDatabase } from '../../src/db/schema.js';
import { createApp, type CreateAppOptions } from '../../src/http/app.js';
import { ProfilesRepository } from '../../src/db/profiles.js';
import { SessionMetadataRepository } from '../../src/db/session-metadata.js';

let server: http.Server | undefined;

function start(opts?: Partial<CreateAppOptions>): Promise<{
  port: number;
  profiles: ProfilesRepository;
  sessions: SessionMetadataRepository;
}> {
  const db = initDatabase(':memory:');
  const profiles = new ProfilesRepository(db);
  const sessions = new SessionMetadataRepository(db);
  const app = createApp({ db, ...opts });
  const s = http.createServer(app);
  server = s;
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve({ port, profiles, sessions });
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('PATCH /api/sessions/:id (Story 1.7 — label)', () => {
  it('sets and clears the display label without touching sessionName', async () => {
    const { port, profiles, sessions } = await start();
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });
    const row = sessions.create({ profileId: p.id, sessionName: 'ckpt-smoke-htop-1' });

    const set = await request(port, 'PATCH', `/api/sessions/${row.id}`, { label: ' Redis local ' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ label: 'Redis local', sessionName: 'ckpt-smoke-htop-1' });

    const clear = await request(port, 'PATCH', `/api/sessions/${row.id}`, { label: '' });
    expect(clear.status).toBe(200);
    expect(clear.body).toMatchObject({ label: null, sessionName: 'ckpt-smoke-htop-1' });
  });

  it('rejects a non-string label and 404s an unknown id', async () => {
    const { port } = await start();
    const bad = await request(port, 'PATCH', '/api/sessions/1', { label: 42 });
    expect(bad.status).toBe(400);
    const missing = await request(port, 'PATCH', '/api/sessions/999', { label: 'x' });
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /api/sessions/:id (Story 1.7 — mata tmux + remove metadados)', () => {
  it('calls onSessionDelete with profile/session BEFORE removing metadata', async () => {
    const calls: Array<[string, string]> = [];
    const { port, profiles, sessions } = await start({
      onSessionDelete: async (profileId, sessionName) => {
        calls.push([profileId, sessionName]);
      },
    });
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });
    const row = sessions.create({ profileId: p.id, sessionName: 'ckpt-smoke-htop-2' });

    const res = await request(port, 'DELETE', `/api/sessions/${row.id}`);
    expect(res.status).toBe(204);
    expect(calls).toEqual([[String(p.id), 'ckpt-smoke-htop-2']]);
    expect(sessions.get(row.id)).toBeNull();
  });

  it('preserves metadata and returns 502 when the remote kill fails', async () => {
    const { port, profiles, sessions } = await start({
      onSessionDelete: async () => {
        throw new Error('ssh down');
      },
    });
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });
    const row = sessions.create({ profileId: p.id, sessionName: 'ckpt-x-claude-1' });

    const res = await request(port, 'DELETE', `/api/sessions/${row.id}`);
    expect(res.status).toBe(502);
    expect(sessions.get(row.id)).not.toBeNull();
  });

  it('without onSessionDelete removes metadata only; 404 for unknown id', async () => {
    const { port, profiles, sessions } = await start();
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });
    const row = sessions.create({ profileId: p.id, sessionName: 'ckpt-y-claude-1' });

    expect((await request(port, 'DELETE', `/api/sessions/${row.id}`)).status).toBe(204);
    expect(sessions.get(row.id)).toBeNull();
    expect((await request(port, 'DELETE', '/api/sessions/999')).status).toBe(404);
  });
});
