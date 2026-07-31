/**
 * GET /api/profiles/:id/sessions tests (Story 1.6, Task 1, AC1/AC10).
 *
 * Exposes the sidebar's data source: the session_metadata rows for a profile.
 * Covers: empty list for a profile with no sessions; the actual rows for a
 * profile with sessions; 404 for an unknown profile (same shape as
 * GET /api/profiles/:id). Runs against an in-memory DB over a real HTTP server,
 * mirroring server/test/server.test.ts (no supertest dependency in this project).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { initDatabase } from '../../src/db/schema.js';
import { createApp } from '../../src/http/app.js';
import { ProfilesRepository } from '../../src/db/profiles.js';
import { SessionMetadataRepository } from '../../src/db/session-metadata.js';

let server: http.Server | undefined;

function start(): Promise<{ port: number; profiles: ProfilesRepository; sessions: SessionMetadataRepository }> {
  const db = initDatabase(':memory:');
  const profiles = new ProfilesRepository(db);
  const sessions = new SessionMetadataRepository(db);
  const app = createApp({ db });
  const s = http.createServer(app);
  server = s;
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve({ port, profiles, sessions });
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }),
        );
      })
      .on('error', reject);
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('GET /api/profiles/:id/sessions (Story 1.6, AC1/AC10)', () => {
  it('returns [] for a profile with no sessions', async () => {
    const { port, profiles } = await start();
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });

    const res = await get(port, `/api/profiles/${p.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns the session_metadata rows for the profile', async () => {
    const { port, profiles, sessions } = await start();
    const p = profiles.create({ name: 'vps', host: 'h', user: 'u', keyPath: '/k' });
    sessions.create({ profileId: p.id, project: 'cockpit', agent: 'claude', sessionName: 'ckpt-cockpit-claude-1' });
    sessions.create({ profileId: p.id, project: 'infra', agent: 'codex', sessionName: 'ckpt-infra-codex-2', status: 'error' });

    const res = await get(port, `/api/profiles/${p.id}/sessions`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      profileId: p.id,
      project: 'cockpit',
      agent: 'claude',
      sessionName: 'ckpt-cockpit-claude-1',
      status: 'active',
    });
    expect(rows[1]).toMatchObject({ project: 'infra', status: 'error' });
  });

  it('does not leak sessions from other profiles', async () => {
    const { port, profiles, sessions } = await start();
    const a = profiles.create({ name: 'a', host: 'h', user: 'u', keyPath: '/k' });
    const b = profiles.create({ name: 'b', host: 'h', user: 'u', keyPath: '/k' });
    sessions.create({ profileId: a.id, project: 'x', sessionName: 'ckpt-x-claude-1' });
    sessions.create({ profileId: b.id, project: 'y', sessionName: 'ckpt-y-claude-1' });

    const res = await get(port, `/api/profiles/${b.id}/sessions`);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileId: b.id, project: 'y' });
  });

  it('returns 404 for an unknown profile', async () => {
    const { port } = await start();
    const res = await get(port, '/api/profiles/999/sessions');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'profile not found' });
  });
});
