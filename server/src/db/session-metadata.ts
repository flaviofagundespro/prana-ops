/**
 * CRUD for tmux session metadata (Story 1.3, AC7 — resolves debt TEST-001 from
 * the Story 1.1 gate).
 *
 * IMPORTANT (PRD F9): this table is CACHE / METADATA ONLY. It is NEVER the source
 * of truth about whether a tmux session is actually alive — that always comes
 * from a live `tmux ls` / `tmux has-session` in real time (see
 * `TmuxSessionManager`). `status` here is a best-effort liveness cache written by
 * the reconciliation loop, not an authority.
 *
 * All statements are parameterized (no string concatenation), following the same
 * pattern as `ProfilesRepository`: snake_case rows in, camelCase objects out.
 */
import type { CockpitDatabase } from './schema.js';

/** Liveness cache states (ratified: exactly these two, @po 2026-07-12). */
export type SessionStatus = 'active' | 'error';

export interface SessionMetadata {
  id: number;
  profileId: number;
  /** Human agenda/topic label; nullable (may be unknown for adopted sessions). */
  project: string | null;
  agenda: string | null;
  /** Selected agent: 'claude' | 'codex' | free-form command. Nullable if unknown. */
  agent: string | null;
  /** tmux session name (ckpt-<projeto>-<agente>-<n>). Nullable for legacy rows. */
  sessionName: string | null;
  /** Rótulo de exibição editável (Story 1.7). NÃO renomeia a sessão tmux. */
  label: string | null;
  status: SessionStatus;
  createdAt: string;
}

export interface CreateSessionMetadataInput {
  profileId: number;
  project?: string | null;
  agenda?: string | null;
  agent?: string | null;
  sessionName?: string | null;
  /** Rótulo de exibição inicial (auto-gerado na criação; editável depois). */
  label?: string | null;
  /** Defaults to 'active'. */
  status?: SessionStatus;
}

export interface UpdateSessionMetadataInput {
  project?: string | null;
  agenda?: string | null;
  agent?: string | null;
  sessionName?: string | null;
  label?: string | null;
  status?: SessionStatus;
}

/** Internal DB row shape (snake_case columns). */
interface SessionMetadataRow {
  id: number;
  profile_id: number;
  project: string | null;
  agenda: string | null;
  agent: string | null;
  session_name: string | null;
  label: string | null;
  status: SessionStatus;
  created_at: string;
}

function rowToMetadata(row: SessionMetadataRow): SessionMetadata {
  return {
    id: row.id,
    profileId: row.profile_id,
    project: row.project,
    agenda: row.agenda,
    agent: row.agent,
    sessionName: row.session_name,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Repository wrapping session metadata persistence. Constructed with an open
 * database so it can be reused with an in-memory DB in tests.
 */
export class SessionMetadataRepository {
  constructor(private readonly db: CockpitDatabase) {}

  create(input: CreateSessionMetadataInput): SessionMetadata {
    const stmt = this.db.prepare(
      `INSERT INTO session_metadata (profile_id, project, agenda, agent, session_name, label, status)
       VALUES (@profileId, @project, @agenda, @agent, @sessionName, @label, @status)`,
    );
    const result = stmt.run({
      profileId: input.profileId,
      project: input.project ?? null,
      agenda: input.agenda ?? null,
      agent: input.agent ?? null,
      sessionName: input.sessionName ?? null,
      label: input.label ?? null,
      status: input.status ?? 'active',
    });
    return this.get(Number(result.lastInsertRowid))!;
  }

  list(): SessionMetadata[] {
    const rows = this.db
      .prepare(`SELECT * FROM session_metadata ORDER BY id ASC`)
      .all() as SessionMetadataRow[];
    return rows.map(rowToMetadata);
  }

  get(id: number): SessionMetadata | null {
    const row = this.db
      .prepare(`SELECT * FROM session_metadata WHERE id = ?`)
      .get(id) as SessionMetadataRow | undefined;
    return row ? rowToMetadata(row) : null;
  }

  /** All sessions for a profile, oldest first. */
  listByProfile(profileId: number): SessionMetadata[] {
    const rows = this.db
      .prepare(`SELECT * FROM session_metadata WHERE profile_id = ? ORDER BY id ASC`)
      .all(profileId) as SessionMetadataRow[];
    return rows.map(rowToMetadata);
  }

  /**
   * Looks up a session by (profile, tmux session name). The pair is the real
   * identity: tmux names are namespaced PER HOST, so the same
   * `ckpt-<projeto>-<agente>-<n>` may legitimately exist on two VPS at once.
   * A global by-name lookup here made the createOrAttach upsert hijack the
   * other profile's row (cross-VPS collision found in field use, 2026-07-14).
   */
  getByProfileAndSessionName(profileId: number, sessionName: string): SessionMetadata | null {
    const row = this.db
      .prepare(`SELECT * FROM session_metadata WHERE profile_id = ? AND session_name = ?`)
      .get(profileId, sessionName) as SessionMetadataRow | undefined;
    return row ? rowToMetadata(row) : null;
  }

  update(id: number, input: UpdateSessionMetadataInput): SessionMetadata | null {
    const existing = this.get(id);
    if (!existing) return null;

    const merged = {
      project: input.project !== undefined ? input.project : existing.project,
      agenda: input.agenda !== undefined ? input.agenda : existing.agenda,
      agent: input.agent !== undefined ? input.agent : existing.agent,
      sessionName: input.sessionName !== undefined ? input.sessionName : existing.sessionName,
      label: input.label !== undefined ? input.label : existing.label,
      status: input.status ?? existing.status,
    };

    this.db
      .prepare(
        `UPDATE session_metadata
         SET project = @project, agenda = @agenda, agent = @agent,
             session_name = @sessionName, label = @label, status = @status
         WHERE id = @id`,
      )
      .run({ ...merged, id });

    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM session_metadata WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
