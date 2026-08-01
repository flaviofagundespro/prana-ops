/**
 * Smoke test (AC7): SQLite schema creates the expected tables and enforces the
 * no-password security invariant (AC5).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyProfileMigrations, initDatabase } from '../src/db/schema.js';

describe('SQLite schema', () => {
  it('creates the profiles and session_metadata tables', () => {
    const db = initDatabase(':memory:');
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('profiles');
    expect(names).toContain('session_metadata');
    db.close();
  });

  it('migrates legacy profiles to kind=ssh idempotently', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE profiles (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER NOT NULL, user TEXT NOT NULL, key_path TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO profiles VALUES (1, 'azure', 'host', 22, 'ubuntu', '/key')`).run();
    applyProfileMigrations(db);
    applyProfileMigrations(db);
    expect(db.prepare(`SELECT kind FROM profiles WHERE id = 1`).get()).toEqual({ kind: 'ssh' });
    db.close();
  });

  it('profiles table has no password/secret column (AC5 invariant)', () => {
    const db = initDatabase(':memory:');
    const columns = db.prepare(`PRAGMA table_info(profiles)`).all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name.toLowerCase());

    expect(columnNames).toContain('key_path');
    expect(columnNames).not.toContain('password');
    expect(columnNames).not.toContain('secret');
    expect(columnNames).not.toContain('passphrase');
    db.close();
  });
});
