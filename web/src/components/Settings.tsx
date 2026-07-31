import { useEffect, useState } from 'react';
import type { WsClient } from '../lib/ws-client.js';

/**
 * Settings screen: CRUD of VPS profiles + per-profile connection test (Story 1.6,
 * Task 4 + Task 5, AC2/AC3/AC4/AC5).
 *
 * Consumes the REST surface already implemented in Story 1.1
 * (`GET/POST/PUT/DELETE /api/profiles[/:id]`). `fetch` is INJECTABLE for tests
 * (same DI spirit as the rest of the app). The server remains the source of truth
 * for validation: a client-side required-fields check avoids an obvious 400
 * round-trip, but a server 400/404 is surfaced inline without breaking the screen.
 *
 * CONNECTION TEST (AC3): each profile has a "Testar conexão" button that sends the
 * ws `profile:test-connection` and renders the per-profile result state
 * (`loading` while waiting for `profile:test-connection:result`, `ok`, or `error`
 * with the server message). The ws NEVER opens a second persistent connection
 * server-side (that discipline lives in the handler — see ws/index.ts).
 *
 * SECURITY: there is NO password field anywhere —
 * only `keyPath` (a filesystem path). A visible note states the SSH key must exist
 * locally with 600 permissions and that the cockpit never stores passwords.
 *
 * SCOPE (AC5): NO Telegram/watcher configuration on this screen — that is Phase 2
 * and deliberately absent (no field, placeholder, or link).
 */

/** Per-profile connection-test UI state. */
type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

/** Profile shape returned by the REST API (id is numeric server-side). */
export interface Profile {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

/** Editable profile fields (create/update payload). */
interface ProfileFormState {
  name: string;
  host: string;
  port: string; // kept as string in the input; parsed on submit
  user: string;
  keyPath: string;
}

const EMPTY_FORM: ProfileFormState = { name: '', host: '', port: '', user: '', keyPath: '' };

/** Injectable fetch (defaults to the global) — matches the browser `fetch` shape. */
export type FetchLike = typeof fetch;

export interface SettingsProps {
  /** Injectable fetcher (tests pass a mock; production uses the global fetch). */
  fetchFn?: FetchLike;
  /**
   * ws client used for the per-profile connection test (AC3). Optional so the
   * CRUD-only tests can render Settings without a ws; when absent, the "Testar
   * conexão" button is disabled.
   */
  ws?: WsClient;
}

export function Settings({ fetchFn = fetch, ws }: SettingsProps): JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  // Subscribe to connection-test results (keyed by profileId). Each result flips
  // that profile's row from `loading` to `ok`/`error`.
  useEffect(() => {
    if (!ws) return undefined;
    return ws.subscribe((message) => {
      if (message.type === 'profile:test-connection:result') {
        setTestStates((prev) => ({
          ...prev,
          [message.profileId]: message.ok
            ? { status: 'ok' }
            : { status: 'error', message: message.message ?? 'falha na conexão' },
        }));
      }
    });
  }, [ws]);

  const testConnection = (id: number): void => {
    if (!ws) return;
    const key = String(id);
    setTestStates((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    ws.send({ type: 'profile:test-connection', profileId: key });
  };

  const loadProfiles = (): void => {
    void fetchFn('/api/profiles')
      .then(async (res) => {
        if (!res.ok) throw new Error('failed to load profiles');
        return (await res.json()) as Profile[];
      })
      .then(setProfiles)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(loadProfiles, [fetchFn]);

  const resetForm = (): void => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const missingRequired = (): boolean =>
    form.name.trim() === '' ||
    form.host.trim() === '' ||
    form.user.trim() === '' ||
    form.keyPath.trim() === '';

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    // Client-side mirror of the server's required fields (avoids an obvious 400).
    if (missingRequired()) {
      setError('name, host, user e keyPath são obrigatórios');
      return;
    }

    const payload: Record<string, unknown> = {
      name: form.name,
      host: form.host,
      user: form.user,
      keyPath: form.keyPath,
    };
    if (form.port.trim() !== '') payload.port = Number(form.port);

    const url = editingId === null ? '/api/profiles' : `/api/profiles/${editingId}`;
    const method = editingId === null ? 'POST' : 'PUT';

    void fetchFn(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `request failed (${res.status})`);
        }
        resetForm();
        loadProfiles();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleEdit = (profile: Profile): void => {
    setEditingId(profile.id);
    setError(null);
    setForm({
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      user: profile.user,
      keyPath: profile.keyPath,
    });
  };

  const handleDelete = (id: number): void => {
    setError(null);
    void fetchFn(`/api/profiles/${id}`, { method: 'DELETE' })
      .then((res) => {
        if (!res.ok) throw new Error(`delete failed (${res.status})`);
        if (editingId === id) resetForm();
        loadProfiles();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="settings">
      <div className="settings__intro">
        <h2>Perfis de VPS</h2>
        <p className="settings__subtitle">Cadastre e gerencie as conexões SSH usadas pelo cockpit.</p>
      </div>

      <p className="settings__key-note">
        <span className="settings__key-note-icon" aria-hidden="true">
          🔒
        </span>
        A chave SSH deve existir localmente com permissão 600; o cockpit nunca armazena senhas.
      </p>

      <form className="settings__form" onSubmit={handleSubmit} aria-label="Perfil de VPS">
        <h3 className="settings__form-title">{editingId === null ? 'Novo perfil' : 'Editando perfil'}</h3>
        <div className="settings__grid">
          <div className="settings__row">
            <label htmlFor="st-name">Nome</label>
            <input id="st-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="settings__row">
            <label htmlFor="st-host">Host</label>
            <input id="st-host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          </div>
          <div className="settings__row">
            <label htmlFor="st-port">Porta</label>
            <input
              id="st-port"
              type="number"
              value={form.port}
              placeholder="22"
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </div>
          <div className="settings__row">
            <label htmlFor="st-user">Usuário</label>
            <input id="st-user" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
          </div>
          <div className="settings__row settings__row--wide">
            <label htmlFor="st-keypath">Path da chave</label>
            <input
              id="st-keypath"
              value={form.keyPath}
              placeholder="/home/user/.ssh/id_ed25519"
              onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
            />
          </div>
        </div>

        <div className="settings__actions">
          <button type="submit" className="settings__btn settings__btn--primary">
            {editingId === null ? 'Criar perfil' : 'Salvar alterações'}
          </button>
          {editingId !== null && (
            <button type="button" className="settings__btn" onClick={resetForm}>
              Cancelar edição
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="settings__error" role="alert">
          {error}
        </p>
      )}

      <ul className="settings__list" aria-label="Perfis existentes">
        {profiles.map((profile) => (
          <li key={profile.id} className="settings__item">
            <span className="settings__item-avatar" aria-hidden="true">
              {profile.name.trim().charAt(0).toUpperCase() || '?'}
            </span>
            <span className="settings__item-info">
              <span className="settings__item-label">
                {profile.name} — {profile.user}@{profile.host}:{profile.port}
              </span>
              {(() => {
                const state = testStates[String(profile.id)] ?? { status: 'idle' };
                if (state.status === 'idle') return null;
                const label =
                  state.status === 'loading'
                    ? 'testando…'
                    : state.status === 'ok'
                      ? 'conexão OK'
                      : `erro: ${state.message}`;
                return (
                  <span
                    className={`settings__test settings__test--${state.status}`}
                    role="status"
                    aria-label={`teste de conexão ${profile.name}: ${state.status}`}
                  >
                    {label}
                  </span>
                );
              })()}
            </span>
            <span className="settings__item-actions">
              <button
                type="button"
                className="settings__btn settings__btn--sm"
                disabled={!ws}
                onClick={() => testConnection(profile.id)}
              >
                Testar conexão {profile.name}
              </button>
              <button type="button" className="settings__btn settings__btn--sm" onClick={() => handleEdit(profile)}>
                Editar {profile.name}
              </button>
              <button
                type="button"
                className="settings__btn settings__btn--sm settings__btn--danger"
                onClick={() => handleDelete(profile.id)}
              >
                Excluir {profile.name}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
