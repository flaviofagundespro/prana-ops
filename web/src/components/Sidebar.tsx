import { useEffect, useState } from 'react';
import type { ProfileOption } from './SessionForm.js';
import { resolveSessionStatus, type SessionCacheStatus } from '../lib/session-status.js';
import { getPreferredProfileId, setPreferredProfileId } from '../lib/profile-pref.js';
import type { SessionStateItem, WatcherSessionStateName } from '../ws-protocol.js';
import { describeCoverage } from '../lib/session-coverage.js';

/**
 * Grouped sidebar: VPS (profile) → project → session (Story 1.6, Task 3, AC1/AC10).
 *
 * For each profile it fetches `GET /api/profiles/:id/sessions` (fetch is INJECTABLE
 * for tests — same DI spirit as WsClient/CreateTerminal in prior stories) and
 * groups the returned sessions by `project`. Sessions with no `project` (adopted
 * without full metadata) group under "Sem projeto". Each session item shows its
 * name + derived status (via {@link toSidebarStatus}) and, on click, calls
 * `onOpenSession(profileId, sessionName)` — the App then attach-or-creates the
 * EXACT named session through the same `session:create` path SessionForm uses
 * (no new session-opening mechanism; UX-001 discipline shared with SessionForm).
 *
 * A profile with no known sessions still appears (header visible, empty body) —
 * AC10 requires the sidebar to show every profile that has at least one known
 * session, and showing empty profiles too is a harmless superset that keeps the
 * multi-VPS structure visible.
 *
 * STATUS SCOPE (AC1, ratified @po): only `idle`/`error` are surfaced this phase;
 * `thinking`/`waiting_for_input` need an output-reading signal no Phase-1 story
 * implements — see `session-status.ts`.
 */

/** Minimal shape of a session row from `GET /api/profiles/:id/sessions`. */
export interface SidebarSession {
  id: number;
  profileId: number;
  project: string | null;
  sessionName: string | null;
  /** Rótulo de exibição editável (Story 1.7); null = mostra o sessionName. */
  label?: string | null;
  status: SessionCacheStatus;
}

/** Injectable fetch (defaults to the global). Returns the parsed session rows. */
export type SessionsFetcher = (profileId: string) => Promise<SidebarSession[]>;

const NO_PROJECT_LABEL = 'Sem projeto';

async function defaultFetchSessions(profileId: string): Promise<SidebarSession[]> {
  const res = await fetch(`/api/profiles/${profileId}/sessions`);
  if (!res.ok) return [];
  return (await res.json()) as SidebarSession[];
}

export interface SidebarProps {
  profiles: ProfileOption[];
  /** Called with the profile id + the EXACT session name of the clicked item. */
  onOpenSession: (profileId: string, sessionName: string) => void;
  /** Injectable fetcher (tests pass a mock; production uses the global fetch). */
  fetchSessions?: SessionsFetcher;
  /**
   * SMK-013 (smoke E2E): mudou → re-busca as sessões. O App passa um valor
   * derivado dos tiles ativos, então criar uma sessão atualiza a sidebar sem
   * exigir o clique manual em "Atualizar sessões".
   */
  refreshKey?: unknown;
  /** Story 1.7: salva o label editado. Resolve quando persistido (re-busca segue). */
  onRenameSession?: (sessionId: number, label: string) => Promise<void>;
  /**
   * Story 1.7: deleta a sessão (mata o tmux na VPS). Confirmação em 2 cliques.
   * Recebe o profileId porque o MESMO sessionName pode existir em outra VPS —
   * o App remove só o tile daquele perfil.
   */
  onDeleteSession?: (profileId: string, sessionId: number, sessionName: string) => Promise<void>;
  /**
   * Story 2.6 (AC6): estado REAL da sessão segundo o watcher, escopado por
   * (profileId, sessionName). undefined = sem sinal → o item cai no liveness
   * da Fase 1 (o watcher REFINA, não substitui). Prop opcional e aditiva.
   */
  getWatcherState?: (
    profileId: string,
    sessionName: string,
  ) => WatcherSessionStateName | undefined;
  /**
   * Story 2.6 (AC3): false = a VPS do perfil está sem watcher acessível —
   * indicação DISCRETA (uma linha), o resto se comporta como Fase 1.
   */
  watcherAvailable?: (profileId: string) => boolean | undefined;
  /**
   * Story 2.9 (AC3/AC6): item completo do watcher para a sessão (com
   * `stateSince`), insumo da cobertura. undefined = o watcher não conhece a
   * sessão — o que é exatamente um dos casos de "sem sinal". Prop aditiva:
   * ausente, a sidebar se comporta como antes da 2.9.
   */
  getWatcherItem?: (profileId: string, sessionName: string) => SessionStateItem | undefined;
  /**
   * Story 2.10/AC5: o cockpit desistiu de re-armar o pipe-pane desta sessão.
   * Só então a UI acusa cano morto — antes disso ela está curando em silêncio.
   */
  pipeUnrecoverable?: (profileId: string, sessionName: string) => boolean;
  /** Story 2.11/AC3: agente iniciado antes dos hooks — informativo, sem ação. */
  agentWithoutHooks?: (profileId: string, sessionName: string) => boolean;
  /** Story 2.12: o agente em uso não lê esses hooks — reciclar não resolve. */
  hooksUnsupported?: (profileId: string, sessionName: string) => boolean;
  /**
   * A sessão está ABERTA no cockpit (tem tile/canal SSH vivo neste browser)?
   *
   * Feedback do uso diário (2026-07-29): com ~15 sessões conhecidas, todas
   * exibiam o mesmo `idle` verde e a sidebar não respondia à pergunta que o
   * operador realmente faz ao escolher janela — "em quais eu já estou?".
   * O dado sempre existiu no App (os tiles); só não chegava aqui.
   *
   * Prop opcional: ausente, o comportamento é o de antes (tudo colorido).
   */
  isSessionOpen?: (profileId: string, sessionName: string) => boolean;
}

/**
 * Rótulo do badge de estado. `waiting_for_input` vira "WAITING" porque o sufixo
 * não distingue nada — não existe outro `waiting` no vocabulário do watcher — e
 * o badge longo empurrava o nome da sessão. Só o TEXTO encurta: a classe e o
 * aria-label seguem `waiting_for_input` (o estado do protocolo não mudou).
 */
function statusLabel(status: string): string {
  return status === 'waiting_for_input' ? 'waiting' : status;
}

/**
 * Agrupa sessões (com nome) por projeto e devolve os grupos em ordem
 * ALFABÉTICA (feedback do uso diário, 2026-07-29).
 *
 * Duas decisões que o agrupamento ingênuo errava:
 *
 * 1. A chave é case-insensitive. Na VPS real conviviam `azure` e `Azure` como
 *    DOIS grupos — mesmo projeto, digitado diferente em momentos diferentes.
 *    Agrupar sem normalizar não resolveria o caso que motivou o pedido.
 *    O rótulo exibido é o da PRIMEIRA ocorrência: previsível e estável, em vez
 *    de eleger uma grafia "correta" que o operador não escolheu.
 *
 * 2. `localeCompare` pt-BR com sensitivity 'base': ordena acento e caixa como o
 *    operador lê ("Ática" perto de "Atica"), não como o code point manda — que
 *    jogaria todo minúsculo depois de todo maiúsculo.
 *
 * "Sem projeto" vai sempre por ÚLTIMO: é o balde do que não tem identidade
 * ainda, e no meio da lista alfabética ele interrompe a varredura visual.
 */
interface ProjectGroup {
  /** Rótulo exibido — a grafia da primeira sessão encontrada do grupo. */
  display: string;
  sessions: SidebarSession[];
}

function groupByProject(sessions: SidebarSession[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    if (session.sessionName === null) continue; // sem nome = nada a reabrir
    const raw = session.project?.trim() ? session.project.trim() : NO_PROJECT_LABEL;
    const key = raw.toLocaleLowerCase('pt-BR');
    const bucket = groups.get(key) ?? { display: raw, sessions: [] };
    bucket.sessions.push(session);
    groups.set(key, bucket);
  }
  const ordered = [...groups.values()];
  ordered.sort((a, b) => {
    if (a.display === NO_PROJECT_LABEL) return 1;
    if (b.display === NO_PROJECT_LABEL) return -1;
    return a.display.localeCompare(b.display, 'pt-BR', { sensitivity: 'base' });
  });
  return ordered;
}

export function Sidebar({
  profiles,
  onOpenSession,
  fetchSessions = defaultFetchSessions,
  refreshKey,
  onRenameSession,
  onDeleteSession,
  getWatcherState,
  watcherAvailable,
  getWatcherItem,
  pipeUnrecoverable,
  agentWithoutHooks,
  hooksUnsupported,
  isSessionOpen,
}: SidebarProps): JSX.Element {
  const [byProfile, setByProfile] = useState<Record<string, SidebarSession[]>>({});
  // Feedback do uso diário (2026-07-15): listar TODAS as VPS com projetos
  // embaixo poluía a sidebar — um dropdown seleciona a VPS e só as sessões
  // dela aparecem. Inicia na última VPS usada (persistida); sem preferência,
  // cai na primeira disponível.
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => getPreferredProfileId() ?? '',
  );
  // Story 1.7 — edição de label: id da sessão em edição + valor do input.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  // Delete em 2 cliques (sem modal do browser): 1º clique arma, 2º confirma.
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null);
  // Bump local para re-buscar após rename/delete sem depender do refreshKey.
  const [localBump, setLocalBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      profiles.map(async (profile) => {
        try {
          const sessions = await fetchSessions(profile.id);
          return [profile.id, sessions] as const;
        } catch {
          return [profile.id, [] as SidebarSession[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setByProfile(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [profiles, fetchSessions, refreshKey, localBump]);

  const saveLabel = async (sessionId: number): Promise<void> => {
    if (!onRenameSession) return;
    try {
      await onRenameSession(sessionId, editValue);
    } finally {
      setEditingId(null);
      setEditValue('');
      setLocalBump((b) => b + 1);
    }
  };

  const confirmDelete = async (
    profileId: string,
    sessionId: number,
    sessionName: string,
  ): Promise<void> => {
    if (!onDeleteSession) return;
    try {
      await onDeleteSession(profileId, sessionId, sessionName);
    } finally {
      setArmedDeleteId(null);
      setLocalBump((b) => b + 1);
    }
  };

  // Perfil efetivamente exibido: o selecionado se ainda existir, senão o 1º.
  const activeProfile =
    profiles.find((p) => p.id === selectedProfileId) ?? profiles[0];

  return (
    <nav className="sidebar" aria-label="Sessões por VPS">
      <select
        className="sidebar__profile-select"
        aria-label="VPS"
        value={activeProfile?.id ?? ''}
        onChange={(e) => {
          setSelectedProfileId(e.target.value);
          setPreferredProfileId(e.target.value);
        }}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {[activeProfile].filter((p): p is ProfileOption => p !== undefined).map((profile) => {
        const groups = groupByProject(byProfile[profile.id] ?? []);
        return (
          <section key={profile.id} className="sidebar__profile">
            {/* AC3 (Story 2.6): degradação DISCRETA — uma linha, sem erro,
                sem spam; todo o resto se comporta exatamente como na Fase 1. */}
            {watcherAvailable?.(profile.id) === false && (
              <p className="sidebar__watcher-note">watcher indisponível</p>
            )}
            <div className="sidebar__projects">
              {groups.map(({ display: project, sessions }) => (
                <div key={project} className="sidebar__project">
                  <h3 className="sidebar__project-name">{project}</h3>
                  <ul className="sidebar__sessions" aria-label={`Sessões de ${project}`}>
                    {sessions.map((session) => {
                      const name = session.sessionName as string;
                      const display = session.label?.trim() ? session.label : name;
                      // Story 2.6 (AC6): o estado do watcher REFINA o liveness
                      // da Fase 1 (error do tmux ls sempre vence — F9).
                      const status = resolveSessionStatus(
                        session.status,
                        getWatcherState?.(profile.id, name),
                      );
                      // Story 2.9 (AC4/AC6): "estou mesmo olhando para isto?"
                      // — separado do ESTADO. Sem cobertura, o `idle` acima é
                      // ausência de informação, não afirmação de calma.
                      const { coverage, reason } = describeCoverage({
                        cacheStatus: session.status,
                        watcherAvailable: watcherAvailable?.(profile.id),
                        stateItem: getWatcherItem?.(profile.id, name),
                        nowMs: Date.now(),
                        pipeUnrecoverable: pipeUnrecoverable?.(profile.id, name),
                        agentWithoutHooks: agentWithoutHooks?.(profile.id, name),
                        hooksUnsupported: hooksUnsupported?.(profile.id, name),
                      });
                      // Verde = "estou plugado aqui". Só o `idle` dessatura
                      // quando a sessão não está aberta: `idle` fechado é
                      // ausência de informação, não afirmação de calma (a mesma
                      // leitura que a 2.9 já fazia com o glifo ⃠). Já
                      // `waiting_for_input`/`error`/`thinking` são estados
                      // AFIRMADOS pelo watcher e mantêm cor mesmo fechados —
                      // são justamente os que precisam ser vistos de longe
                      // quando o operador NÃO está com a sessão aberta.
                      const isOpen = isSessionOpen?.(profile.id, name) ?? true;
                      const statusTone = status === 'idle' && !isOpen ? 'idle-detached' : status;
                      const isEditing = editingId === session.id;
                      const isArmed = armedDeleteId === session.id;
                      return (
                        <li key={session.id} className="sidebar__session">
                          {isEditing ? (
                            <span className="sidebar__session-edit">
                              <input
                                type="text"
                                className="sidebar__session-input"
                                aria-label={`Novo label de ${name}`}
                                value={editValue}
                                autoFocus
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveLabel(session.id);
                                  if (e.key === 'Escape') setEditingId(null);
                                }}
                              />
                              <button
                                type="button"
                                className="sidebar__session-action"
                                aria-label={`Salvar label de ${name}`}
                                onClick={() => void saveLabel(session.id)}
                              >
                                ✓
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={`sidebar__session-btn sidebar__session-btn--${status}`}
                              title={name}
                              onClick={() => onOpenSession(profile.id, name)}
                            >
                              <span className="sidebar__session-name">{display}</span>
                              {/* Story 2.9 (AC6): marca de AUSÊNCIA de sinal.
                                  Sem cor nova — a paleta pertence aos estados
                                  do watcher, e waiting_for_input tem de seguir
                                  sendo o elemento mais saliente da tela. */}
                              {coverage !== 'covered' && (
                                <span
                                  className={`sidebar__coverage sidebar__coverage--${coverage}`}
                                  title={reason}
                                  aria-label={`sem sinal: ${reason ?? coverage}`}
                                >
                                  ⃠
                                </span>
                              )}
                              <span
                                className={`sidebar__status sidebar__status--${statusTone}`}
                                aria-label={`status: ${status}`}
                                title={isOpen ? 'aberta no cockpit' : 'não aberta no cockpit'}
                              >
                                {statusLabel(status)}
                              </span>
                            </button>
                          )}
                          {!isEditing && onRenameSession && (
                            <button
                              type="button"
                              className="sidebar__session-action"
                              aria-label={`Editar label de ${name}`}
                              title="Editar label"
                              onClick={() => {
                                setEditingId(session.id);
                                setEditValue(session.label ?? '');
                                setArmedDeleteId(null);
                              }}
                            >
                              ✎
                            </button>
                          )}
                          {!isEditing && onDeleteSession && (
                            <button
                              type="button"
                              className={
                                isArmed
                                  ? 'sidebar__session-action sidebar__session-action--danger'
                                  : 'sidebar__session-action'
                              }
                              aria-label={
                                isArmed ? `Confirmar exclusão de ${name}` : `Excluir ${name}`
                              }
                              title={
                                isArmed
                                  ? 'Confirmar: mata a sessão tmux na VPS'
                                  : 'Excluir sessão (2 cliques)'
                              }
                              onClick={() => {
                                if (isArmed) void confirmDelete(profile.id, session.id, name);
                                else setArmedDeleteId(session.id);
                              }}
                            >
                              {isArmed ? 'confirmar?' : '✕'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </nav>
  );
}
