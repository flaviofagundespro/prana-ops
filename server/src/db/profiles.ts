/**
 * Basic CRUD for VPS connection profiles (AC4).
 *
 * A profile references an SSH key by PATH only (`keyPath`). There is no
 * password field and never will be. Callers pass
 * a path to a private key already present on the filesystem with chmod 600.
 */
import type { CockpitDatabase } from './schema.js';

export interface Profile {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Filesystem path to the SSH private key. Never key contents, never a password. */
  keyPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  name: string;
  host: string;
  port?: number;
  user: string;
  keyPath: string;
}

export interface UpdateProfileInput {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  keyPath?: string;
}

/** Internal DB row shape (snake_case columns). */
interface ProfileRow {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  key_path: string;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    user: row.user,
    keyPath: row.key_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository wrapping profile persistence. Constructed with an open database
 * so it can be reused with an in-memory DB in tests.
 */
export class ProfilesRepository {
  constructor(private readonly db: CockpitDatabase) {}

  create(input: CreateProfileInput): Profile {
    const stmt = this.db.prepare(
      `INSERT INTO profiles (name, host, port, user, key_path)
       VALUES (@name, @host, @port, @user, @keyPath)`,
    );
    const result = stmt.run({
      name: input.name,
      host: input.host,
      port: input.port ?? 22,
      user: input.user,
      keyPath: input.keyPath,
    });
    return this.get(Number(result.lastInsertRowid))!;
  }

  list(): Profile[] {
    const rows = this.db
      .prepare(`SELECT * FROM profiles ORDER BY id ASC`)
      .all() as ProfileRow[];
    return rows.map(rowToProfile);
  }

  get(id: number): Profile | null {
    const row = this.db
      .prepare(`SELECT * FROM profiles WHERE id = ?`)
      .get(id) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  update(id: number, input: UpdateProfileInput): Profile | null {
    const existing = this.get(id);
    if (!existing) return null;

    const merged = {
      name: input.name ?? existing.name,
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
      user: input.user ?? existing.user,
      keyPath: input.keyPath ?? existing.keyPath,
    };

    this.db
      .prepare(
        `UPDATE profiles
         SET name = @name, host = @host, port = @port, user = @user,
             key_path = @keyPath, updated_at = datetime('now')
         WHERE id = @id`,
      )
      .run({ ...merged, id });

    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
