import { useEffect, useState } from 'react';
import type { WsClient } from '../lib/ws-client.js';
import type { SessionCreatedAck } from '../ws-protocol.js';
import { parseSessionName } from '../lib/session-name.js';
import { getPreferredProfileId } from '../lib/profile-pref.js';

/**
 * Minimal session creation + listing form (AC6, Story 1.4).
 *
 * Fields: perfil (from a mock/hardcoded list — the profiles Settings CRUD is
 * Story 1.6, ratified @po), projeto, pauta, agente. On submit it sends
 * `session:create`; it subscribes to `session:created` (bubbled up via
 * `onSessionCreated` so the App can spawn a tile keyed by the server-minted
 * channelId), `session:error` (rendered inline — no fancy toast, functional
 * minimum), and `session:list` (populates the reopen list).
 *
 * Reopening a known session = a fresh `session:create` with the same project/
 * agent; the server does attach-or-create (Story 1.3). No new "attach by name"
 * message is introduced — none is needed.
 */

/** A selectable profile. Hardcoded/mock in 1.4 (real CRUD is 1.6). */
export interface ProfileOption {
  id: string;
  label: string;
}

/** Default mock profile so the form is usable before Settings (1.6) exists. */
export const MOCK_PROFILES: ProfileOption[] = [{ id: '1', label: 'VPS local (mock)' }];

export interface SessionFormProps {
  ws: WsClient;
  /**
   * Notificado quando um `session:created` chega COM O FORM MONTADO (fechar o
   * diálogo, etc.). A criação do TILE não depende dele: o App assina o ws
   * diretamente — o form agora vive num diálogo desmontado na maior parte do
   * tempo, e acks de reabertura via sidebar precisam de dono permanente.
   */
  onSessionCreated?: (ack: SessionCreatedAck) => void;
  /** Selectable profiles. Defaults to {@link MOCK_PROFILES}. */
  profiles?: ProfileOption[];
}

export function SessionForm({ ws, onSessionCreated, profiles = MOCK_PROFILES }: SessionFormProps): JSX.Element {
  // Inicia na VPS preferida (a última usada na sidebar) quando ela existe na
  // lista; senão, na primeira. O form monta a cada abertura do diálogo, então
  // a preferência é relida na hora.
  const [profileId, setProfileId] = useState(() => {
    const preferred = getPreferredProfileId();
    return profiles.some((p) => p.id === preferred) ? (preferred as string) : profiles[0]?.id ?? '';
  });
  const [projeto, setProjeto] = useState('');
  const [pauta, setPauta] = useState('');
  const [agente, setAgente] = useState('claude');
  const [error, setError] = useState<string | null>(null);
  const [knownSessions, setKnownSessions] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = ws.subscribe((message) => {
      switch (message.type) {
        case 'session:created':
          setError(null);
          onSessionCreated?.(message);
          break;
        case 'session:error':
          setError(message.message);
          break;
        case 'session:list':
          setKnownSessions(message.sessions);
          break;
        default:
          break;
      }
    });
    // Ask for existing sessions on mount.
    if (profileId) ws.send({ type: 'session:list', profileId });
    return unsubscribe;
  }, [ws, onSessionCreated, profileId]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    ws.send({ type: 'session:create', profileId, projeto, pauta, agente });
  };

  const refreshSessions = (): void => {
    if (profileId) ws.send({ type: 'session:list', profileId });
  };

  /**
   * UX-001 fix (Story 1.6, AC7): "Reabrir {name}" must target the EXACT session
   * the button names — attach-or-create the same tmux session — NOT whatever the
   * form fields currently hold (they may have drifted since the list loaded).
   * We parse `projeto`/`assunto`/`n` FROM THE CLICKED NAME (via the mirror of the
   * server's `parseSessionName`) and send those. If the name is outside the
   * canonical `ckpt-<projeto>-<assunto>-<n>` shape (e.g. an adopted legacy name),
   * `parseSessionName` returns null and we FALL BACK to the current form values
   * (documented fallback — never throws, never breaks the button).
   */
  const reopenSession = (name: string): void => {
    const parsed = parseSessionName(name);
    if (parsed) {
      // Story 2.12: `pauta` (o assunto) é o que reconstrói o nome no server.
      ws.send({
        type: 'session:create',
        profileId,
        projeto: parsed.projeto,
        pauta: parsed.assunto,
        agente,
        n: parsed.n,
      });
      return;
    }
    // Fallback for a non-canonical name: reuse the current form values.
    ws.send({ type: 'session:create', profileId, projeto, pauta, agente });
  };

  return (
    <form className="session-form" onSubmit={handleSubmit} aria-label="Criar sessão">
      <div className="session-form__row">
        <label htmlFor="sf-profile">Perfil</label>
        <select
          id="sf-profile"
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="session-form__row">
        <label htmlFor="sf-projeto">Projeto</label>
        <input
          id="sf-projeto"
          value={projeto}
          onChange={(e) => setProjeto(e.target.value)}
          required
        />
      </div>

      <div className="session-form__row">
        <label htmlFor="sf-pauta">Pauta</label>
        <input id="sf-pauta" value={pauta} onChange={(e) => setPauta(e.target.value)} />
      </div>

      <div className="session-form__row">
        <label htmlFor="sf-agente">Agente</label>
        <input
          id="sf-agente"
          value={agente}
          onChange={(e) => setAgente(e.target.value)}
          placeholder="claude, codex ou comando livre"
        />
      </div>

      <div className="session-form__actions">
        <button type="submit">Criar sessão</button>
        <button type="button" onClick={refreshSessions}>
          Atualizar sessões
        </button>
      </div>

      {error && (
        <p className="session-form__error" role="alert">
          {error}
        </p>
      )}

      {knownSessions.length > 0 && (
        <div className="session-form__known">
          <h3>Sessões existentes</h3>
          <ul aria-label="Sessões existentes">
            {knownSessions.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => reopenSession(name)}>
                  Reabrir {name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
