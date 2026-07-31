/**
 * Express application factory.
 *
 * Exposes a health check, a basic REST surface for profile CRUD (AC4), and
 * serves the built Vite SPA statically (AC1). Kept as a factory so tests can
 * construct an app against an in-memory database without opening a port.
 */
import express, { type Express, type Request, type Response } from 'express';
import fs from 'node:fs';
import type { CockpitDatabase } from '../db/schema.js';
import { ProfilesRepository, type CreateProfileInput } from '../db/profiles.js';
import { SessionMetadataRepository } from '../db/session-metadata.js';

export interface CreateAppOptions {
  db: CockpitDatabase;
  /** Absolute path to the built frontend (web/dist). Optional in tests. */
  webDist?: string;
  /**
   * Invocado após excluir um perfil, para derrubar a conexão SSH e a
   * reconciliação associadas (SMK-003 do smoke E2E: sem isso, a máquina de
   * reconexão de um perfil excluído fica tentando handshake para sempre).
   */
  onProfileDeleted?: (profileId: string) => void;
  /**
   * Story 1.7: invocado ao deletar uma sessão para MATAR a sessão tmux na VPS
   * (tmux kill-session, guard ckpt-) antes de remover os metadados locais.
   * Ausente (testes/uso sem SSH), só os metadados são removidos.
   */
  onSessionDelete?: (profileId: string, sessionName: string) => Promise<void>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createApp({ db, webDist, onProfileDeleted, onSessionDelete }: CreateAppOptions): Express {
  const app = express();
  const profiles = new ProfilesRepository(db);
  const sessions = new SessionMetadataRepository(db);

  app.use(express.json());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'prana-ops', ts: new Date().toISOString() });
  });

  // --- Profiles CRUD (AC4) ---

  app.get('/api/profiles', (_req: Request, res: Response) => {
    res.json(profiles.list());
  });

  app.get('/api/profiles/:id', (req: Request, res: Response) => {
    const profile = profiles.get(Number(req.params.id));
    if (!profile) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    res.json(profile);
  });

  /**
   * Story 1.6 (Task 1, AC1/AC10): sessions for a profile, feeding the grouped
   * sidebar. Exposes over REST what `SessionMetadataRepository.listByProfile`
   * already reads from SQLite — no new repository, no new query. 404 mirrors the
   * `GET /api/profiles/:id` pattern so the sidebar never groups an unknown profile.
   */
  app.get('/api/profiles/:id/sessions', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!profiles.get(id)) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    res.json(sessions.listByProfile(id));
  });

  app.post('/api/profiles', (req: Request, res: Response) => {
    const body = req.body as Partial<CreateProfileInput>;
    if (
      !isNonEmptyString(body.name) ||
      !isNonEmptyString(body.host) ||
      !isNonEmptyString(body.user) ||
      !isNonEmptyString(body.keyPath)
    ) {
      res
        .status(400)
        .json({ error: 'name, host, user and keyPath are required (keyPath is a filesystem path)' });
      return;
    }
    const created = profiles.create({
      name: body.name,
      host: body.host,
      port: typeof body.port === 'number' ? body.port : undefined,
      user: body.user,
      keyPath: body.keyPath,
    });
    res.status(201).json(created);
  });

  app.put('/api/profiles/:id', (req: Request, res: Response) => {
    const updated = profiles.update(Number(req.params.id), req.body ?? {});
    if (!updated) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    res.json(updated);
  });

  app.delete('/api/profiles/:id', (req: Request, res: Response) => {
    const removed = profiles.delete(Number(req.params.id));
    if (!removed) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    onProfileDeleted?.(String(req.params.id));
    res.status(204).end();
  });

  // --- Sessions (Story 1.7): editar label + deletar sessão ---

  // Label é SÓ exibição (não renomeia a sessão tmux — o nome ckpt-* é a chave
  // técnica e segue imutável). null/'' limpa o label.
  app.patch('/api/sessions/:id', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { label?: unknown };
    if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') {
      res.status(400).json({ error: 'label must be a string or null' });
      return;
    }
    const label =
      body.label === undefined || body.label === null || body.label.trim().length === 0
        ? null
        : body.label.trim();
    const updated = sessions.update(Number(req.params.id), { label });
    if (!updated) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(updated);
  });

  // Delete = mata a sessão tmux na VPS (via onSessionDelete → killSession,
  // allowlist ckpt-) e remove os metadados. Idempotente do lado tmux (matar
  // sessão já morta não é erro).
  app.delete('/api/sessions/:id', (req: Request, res: Response) => {
    const row = sessions.get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const finish = (): void => {
      sessions.delete(row.id);
      res.status(204).end();
    };
    if (onSessionDelete && row.sessionName) {
      onSessionDelete(String(row.profileId), row.sessionName)
        .then(finish)
        .catch((err: unknown) => {
          res.status(502).json({
            error: `failed to kill tmux session: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    } else {
      finish();
    }
  });

  // --- Static SPA (AC1) ---

  if (webDist && fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback: any non-API GET returns index.html.
    app.get(/^(?!\/api\/|\/ws).*/, (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: webDist });
    });
  }

  return app;
}
