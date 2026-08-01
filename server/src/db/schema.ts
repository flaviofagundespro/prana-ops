/**
 * SQLite schema for the Prana OPS.
 *
 * IMPORTANT SECURITY INVARIANT:
 * The database stores ONLY a filesystem PATH to the SSH key (`key_path`).
 * It NEVER stores the key contents, and it NEVER stores a password or any
 * cleartext secret in ANY table. If a future migration is tempted to add a
 * `password` column — it must not. Secrets live on the filesystem (chmod 600),
 * managed by the operator, not by this app.
 *
 * The database is cache/metadata only, never the source of truth (PRD F9).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type CockpitDatabase = Database.Database;

/**
 * DDL applied idempotently on startup (schema-on-boot). Using
 * `CREATE TABLE IF NOT EXISTS` keeps this safe to run every boot without a
 * dedicated migration runner in the MVP.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  host        TEXT    NOT NULL,
  port        INTEGER NOT NULL DEFAULT 22,
  user        TEXT    NOT NULL,
  -- key_path: filesystem path to the SSH private key (expected chmod 600 on
  -- disk, NOT managed by this app). NEVER the key contents. NEVER a password.
  key_path    TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_metadata (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  INTEGER NOT NULL,
  project     TEXT,
  agenda      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_metadata_profile
  ON session_metadata (profile_id);
`;

/**
 * Columns added to `session_metadata` by Story 1.3 (F1: agent; F9: tmux session
 * name + liveness state). SQLite has no `ADD COLUMN IF NOT EXISTS`, so we apply
 * these idempotently by inspecting `PRAGMA table_info` before each `ALTER TABLE`
 * — same schema-on-boot spirit as `CREATE TABLE IF NOT EXISTS`.
 *
 * `status` is intentionally NOT enforced with a CHECK at the DB layer here to keep
 * the ALTER idempotent and migration-friendly; the {@link CreateSessionMetadataInput}
 * type in `session-metadata.ts` restricts callers to the ratified set
 * `active | error`. `status` is cache/metadata — never a source of truth about
 * whether the tmux session is actually alive (that always comes from live
 * `tmux ls` — PRD F9).
 */
const SESSION_METADATA_ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  // The agent selected for this session (claude | codex | free-form command).
  { name: 'agent', ddl: `ALTER TABLE session_metadata ADD COLUMN agent TEXT` },
  // The tmux session name (ckpt-<projeto>-<agente>-<n>) this row describes.
  { name: 'session_name', ddl: `ALTER TABLE session_metadata ADD COLUMN session_name TEXT` },
  // Liveness cache: 'active' | 'error'. Defaults to 'active' on insert.
  {
    name: 'status',
    ddl: `ALTER TABLE session_metadata ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  },
  // Story 1.7: rótulo de exibição editável pelo usuário (NÃO renomeia a sessão
  // tmux — o nome ckpt-* segue imutável e é a chave técnica; o label é só UI).
  { name: 'label', ddl: `ALTER TABLE session_metadata ADD COLUMN label TEXT` },
];

/**
 * Story 2.19 — profiles created before local environments existed are SSH by
 * definition. Adding the discriminator with a DEFAULT keeps every existing row
 * usable without rewriting credentials or requiring a manual migration.
 */
export function applyProfileMigrations(db: CockpitDatabase): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(profiles)`).all() as Array<{ name: string }>).map(
      (col) => col.name,
    ),
  );
  if (!existing.has('kind')) {
    db.exec(`ALTER TABLE profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh'`);
  }
}

/**
 * Idempotently applies the Story 1.3 `session_metadata` column additions. Safe to
 * run on every boot: a column that already exists is skipped. Exported so tests
 * can assert idempotency directly.
 */
export function applySessionMetadataMigrations(db: CockpitDatabase): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(session_metadata)`).all() as Array<{ name: string }>).map(
      (col) => col.name,
    ),
  );
  for (const column of SESSION_METADATA_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(column.ddl);
    }
  }
  // A supporting index for getByProfileAndSessionName lookups (documented
  // decision: session identity is the (profile_id, session_name) PAIR — the
  // same tmux name may exist on two VPS — queried during upsert, adoption and
  // reconciliation). The older single-column index is kept for existing DBs;
  // both are idempotent.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_metadata_session_name
       ON session_metadata (session_name);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_metadata_profile_session
       ON session_metadata (profile_id, session_name);`,
  );
}

/**
 * Opens (creating parent dirs and file if needed) the SQLite database and
 * applies the schema. Enables foreign keys so cascade deletes work.
 */
export function initDatabase(dbPath: string): CockpitDatabase {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyProfileMigrations(db);
  // Story 1.3: idempotent column additions to session_metadata (agent,
  // session_name, status). Run after the base CREATE so an existing DB from
  // Story 1.1 is upgraded in place.
  applySessionMetadataMigrations(db);
  return db;
}
