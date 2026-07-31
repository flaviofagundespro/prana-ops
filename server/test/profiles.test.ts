/**
 * Smoke test (AC4): basic CRUD for profiles works end to end against an
 * in-memory database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/db/schema.js';
import { ProfilesRepository } from '../src/db/profiles.js';

describe('ProfilesRepository CRUD', () => {
  let repo: ProfilesRepository;

  beforeEach(() => {
    const db = initDatabase(':memory:');
    repo = new ProfilesRepository(db);
  });

  it('creates and reads a profile back', () => {
    const created = repo.create({
      name: 'prod-vps',
      host: '10.0.0.1',
      user: 'deploy',
      keyPath: '/home/deploy/.ssh/id_ed25519',
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.port).toBe(22); // default
    expect(created.keyPath).toBe('/home/deploy/.ssh/id_ed25519');

    const fetched = repo.get(created.id);
    expect(fetched?.name).toBe('prod-vps');
  });

  it('lists, updates and deletes profiles', () => {
    const a = repo.create({ name: 'a', host: 'h1', user: 'u1', keyPath: '/k/a' });
    repo.create({ name: 'b', host: 'h2', user: 'u2', keyPath: '/k/b', port: 2222 });

    expect(repo.list()).toHaveLength(2);

    const updated = repo.update(a.id, { host: 'new-host', port: 2200 });
    expect(updated?.host).toBe('new-host');
    expect(updated?.port).toBe(2200);

    expect(repo.delete(a.id)).toBe(true);
    expect(repo.get(a.id)).toBeNull();
    expect(repo.list()).toHaveLength(1);
  });

  it('returns null/false for missing profiles', () => {
    expect(repo.get(999)).toBeNull();
    expect(repo.update(999, { name: 'x' })).toBeNull();
    expect(repo.delete(999)).toBe(false);
  });
});
