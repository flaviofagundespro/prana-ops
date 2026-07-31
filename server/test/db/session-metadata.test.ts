/**
 * SessionMetadataRepository CRUD tests (Story 1.3, AC7 / AC10, Task 6).
 * Resolves debt TEST-001 carried from the Story 1.1 gate.
 *
 * Covers: create/list/get/update/delete + listByProfile + getByProfileAndSessionName,
 * the FK ON DELETE CASCADE behavior, default status, and idempotency of the
 * schema migration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, applySessionMetadataMigrations } from '../../src/db/schema.js';
import { ProfilesRepository } from '../../src/db/profiles.js';
import { SessionMetadataRepository } from '../../src/db/session-metadata.js';
import type { CockpitDatabase } from '../../src/db/schema.js';

describe('SessionMetadataRepository CRUD (AC7)', () => {
  let db: CockpitDatabase;
  let profiles: ProfilesRepository;
  let sessions: SessionMetadataRepository;
  let profileId: number;

  beforeEach(() => {
    db = initDatabase(':memory:');
    profiles = new ProfilesRepository(db);
    sessions = new SessionMetadataRepository(db);
    profileId = profiles.create({
      name: 'vps',
      host: 'h',
      user: 'u',
      keyPath: '/k',
    }).id;
  });

  it('creates a session with defaults and reads it back', () => {
    const created = sessions.create({
      profileId,
      project: 'pranaops',
      agenda: 'ship 1.3',
      agent: 'claude',
      sessionName: 'ckpt-pranaops-claude-1',
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe('active'); // default
    expect(created.sessionName).toBe('ckpt-pranaops-claude-1');
    expect(created.createdAt).toBeTruthy();

    const fetched = sessions.get(created.id);
    expect(fetched?.agent).toBe('claude');
    expect(fetched?.project).toBe('pranaops');
  });

  it('allows nullable metadata for adopted sessions', () => {
    const created = sessions.create({ profileId, sessionName: 'ckpt-x-y-9' });
    expect(created.project).toBeNull();
    expect(created.agenda).toBeNull();
    expect(created.agent).toBeNull();
    expect(created.status).toBe('active');
  });

  it('lists, updates, and deletes sessions', () => {
    const a = sessions.create({ profileId, sessionName: 'ckpt-a-claude-1' });
    sessions.create({ profileId, sessionName: 'ckpt-b-codex-1' });

    expect(sessions.list()).toHaveLength(2);

    const updated = sessions.update(a.id, { status: 'error', agenda: 'died' });
    expect(updated?.status).toBe('error');
    expect(updated?.agenda).toBe('died');
    // Unchanged fields are preserved.
    expect(updated?.sessionName).toBe('ckpt-a-claude-1');

    expect(sessions.delete(a.id)).toBe(true);
    expect(sessions.get(a.id)).toBeNull();
    expect(sessions.list()).toHaveLength(1);
  });

  it('returns null/false for missing sessions', () => {
    expect(sessions.get(999)).toBeNull();
    expect(sessions.update(999, { status: 'error' })).toBeNull();
    expect(sessions.delete(999)).toBe(false);
  });

  it('lists sessions filtered by profile', () => {
    const otherProfile = profiles.create({ name: 'vps2', host: 'h2', user: 'u2', keyPath: '/k2' }).id;
    sessions.create({ profileId, sessionName: 'ckpt-a-claude-1' });
    sessions.create({ profileId, sessionName: 'ckpt-a-claude-2' });
    sessions.create({ profileId: otherProfile, sessionName: 'ckpt-z-codex-1' });

    expect(sessions.listByProfile(profileId)).toHaveLength(2);
    expect(sessions.listByProfile(otherProfile)).toHaveLength(1);
    expect(sessions.listByProfile(profileId).every((s) => s.profileId === profileId)).toBe(true);
  });

  it('looks up a session by (profile, tmux session name)', () => {
    sessions.create({ profileId, sessionName: 'ckpt-pranaops-claude-1', agent: 'claude' });
    const found = sessions.getByProfileAndSessionName(profileId, 'ckpt-pranaops-claude-1');
    expect(found?.agent).toBe('claude');
    expect(sessions.getByProfileAndSessionName(profileId, 'ckpt-nonexistent-x-1')).toBeNull();
  });

  it('scopes the session-name lookup per profile (same tmux name on two VPS)', () => {
    // tmux names are namespaced PER HOST: the same ckpt-* name on two profiles
    // is legitimate and must resolve to DIFFERENT rows (cross-VPS collision
    // found in field use, 2026-07-14).
    const otherProfile = profiles.create({ name: 'vps2', host: 'h2', user: 'u2', keyPath: '/k2' }).id;
    sessions.create({ profileId, sessionName: 'ckpt-equipe-claude-1', agent: 'claude' });
    sessions.create({ profileId: otherProfile, sessionName: 'ckpt-equipe-claude-1', agent: 'codex' });

    expect(sessions.getByProfileAndSessionName(profileId, 'ckpt-equipe-claude-1')?.agent).toBe('claude');
    expect(sessions.getByProfileAndSessionName(otherProfile, 'ckpt-equipe-claude-1')?.agent).toBe('codex');
    // A profile with no such session finds nothing — never the other VPS's row.
    const thirdProfile = profiles.create({ name: 'vps3', host: 'h3', user: 'u3', keyPath: '/k3' }).id;
    expect(sessions.getByProfileAndSessionName(thirdProfile, 'ckpt-equipe-claude-1')).toBeNull();
  });

  it('cascades deletes when the parent profile is removed (FK ON DELETE CASCADE)', () => {
    sessions.create({ profileId, sessionName: 'ckpt-a-claude-1' });
    sessions.create({ profileId, sessionName: 'ckpt-a-claude-2' });
    expect(sessions.listByProfile(profileId)).toHaveLength(2);

    profiles.delete(profileId);

    // The session rows are gone thanks to ON DELETE CASCADE.
    expect(sessions.listByProfile(profileId)).toHaveLength(0);
    expect(sessions.list()).toHaveLength(0);
  });

  it('rejects a session referencing a non-existent profile (FK constraint)', () => {
    expect(() => sessions.create({ profileId: 424242, sessionName: 'ckpt-x-y-1' })).toThrow();
  });
});

describe('applySessionMetadataMigrations — idempotency (AC7)', () => {
  it('is safe to run multiple times', () => {
    const db = initDatabase(':memory:');
    // initDatabase already ran it once; running again must not throw.
    expect(() => applySessionMetadataMigrations(db)).not.toThrow();
    expect(() => applySessionMetadataMigrations(db)).not.toThrow();

    const cols = (db.prepare(`PRAGMA table_info(session_metadata)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('agent');
    expect(cols).toContain('session_name');
    expect(cols).toContain('status');
  });
});
