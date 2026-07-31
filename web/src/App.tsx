import { useCallback, useEffect, useMemo, useState } from 'react';
import { SessionForm, MOCK_PROFILES, type ProfileOption } from './components/SessionForm.js';
import { Sidebar, type SidebarSession } from './components/Sidebar.js';
import { Settings, type Profile } from './components/Settings.js';
import { TerminalGrid, type GridLayout } from './components/TerminalGrid.js';
import { GridControls, type CoverageBadge } from './components/GridControls.js';
import { DecisionsPanel } from './components/DecisionsPanel.js';
import type { CreateTerminal } from './components/TerminalTile.js';
import { useSessions } from './hooks/useSessions.js';
import { useGridSlots } from './hooks/useGridSlots.js';
import { useWatcher } from './hooks/useWatcher.js';
import { createConnection } from './lib/connection.js';
import { parseSessionName } from './lib/session-name.js';
import { describeCoverage } from './lib/session-coverage.js';
import type { WsClient } from './lib/ws-client.js';

/**
 * Root component for the Prana OPS SPA (Story 1.4 → extended in Story 1.6).
 *
 * Story 1.6 adds:
 *  - a grouped {@link Sidebar} (VPS → project → session), fed by real profiles;
 *  - real profile options for {@link SessionForm} via `GET /api/profiles`
 *    (replacing MOCK_PROFILES as the production default — AC6);
 *  - a minimal Console ↔ Settings navigation with NO router (local `view`
 *    state — AC9). The Console stays MOUNTED behind `display:none` when Settings
 *    is shown (the TerminalGrid pattern from Story 1.4), so open tiles/sockets are
 *    never torn down on navigation (AC9/AC10).
 *
 * It still owns the ONE shared ws client (created once), the active tile list, and
 * the grid layout. `ws`, `createTerminal`, and `fetchFn` are injectable for tests.
 */
export interface AppProps {
  /** Injectable shared ws client. Defaults to a real WebSocket connection. */
  ws?: WsClient;
  /** Test seam: injectable terminal factory forwarded to each tile. */
  createTerminal?: CreateTerminal;
  /** Injectable fetch (tests pass a mock; production uses the global fetch). */
  fetchFn?: typeof fetch;
}

type View = 'dashboard' | 'settings';

/** Maps a REST Profile (numeric id) to a SessionForm/Sidebar ProfileOption.
 * Only the VPS name is shown here (no host/IP) so the Dashboard stays safe
 * to screenshot/record; the IP remains visible in Settings. */
function toProfileOption(profile: Profile): ProfileOption {
  return { id: String(profile.id), label: profile.name };
}

export function App({ ws: injectedWs, createTerminal, fetchFn = fetch }: AppProps = {}): JSX.Element {
  // Create the shared client once. `useMemo` keeps a single instance across
  // re-renders; a real connection is only opened when no ws is injected.
  const ws = useMemo(() => injectedWs ?? createConnection(), [injectedWs]);

  const { tiles, addTileFromAck, removeTile } = useSessions();
  const [layout, setLayout] = useState<GridLayout>(4);
  const [view, setView] = useState<View>('dashboard');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  // Feedback do uso diário (2026-07-15): o form de criar sessão poluía a
  // sidebar — virou botão "+ Nova sessão" que abre este diálogo.
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  // Menu lateral recolhível (padrão dos chats de IA). Recolhido vira um
  // trilho fino com expandir + criar sessão; os terminais se reajustam via
  // ResizeObserver dos tiles.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Estado de slots do grid — compartilhado entre o header (GridControls:
  // layouts + abas) e o TerminalGrid (painéis).
  const { visibleIds, activeIndex, activateSlot, promoteToActiveSlot } = useGridSlots(tiles, layout);
  // Story 2.6: fila de decisões + estado real por sessão, sincronizados do
  // watcher via o MESMO ws compartilhado (decisions:update / sessions:state).
  const watcher = useWatcher(ws);
  const [decisionsPanelOpen, setDecisionsPanelOpen] = useState(false);

  // Story 2.9 (AC4/AC6): cobertura da sessão de uma ABA. Um tile aberto tem
  // canal vivo, então `cacheStatus` é 'active' por construção aqui — o caso
  // 'error' (sessão sumiu do tmux ls) é assunto da sidebar, que tem o cache.
  const coverageOf = useCallback(
    (profileId: string, sessionName: string): CoverageBadge =>
      describeCoverage({
        cacheStatus: 'active',
        watcherAvailable: watcher.watcherAvailable(profileId),
        stateItem: watcher.stateItemOf(profileId, sessionName),
        nowMs: Date.now(),
        pipeUnrecoverable: watcher.pipeUnrecoverable(profileId, sessionName),
        agentWithoutHooks: watcher.agentWithoutHooks(profileId, sessionName),
        hooksUnsupported: watcher.hooksUnsupported(profileId, sessionName),
      }),
    [watcher],
  );

  // Fetch real profiles once on mount (AC6). An empty/failed list falls back to
  // MOCK_PROFILES so the form stays usable (e.g. before any profile is created).
  useEffect(() => {
    let cancelled = false;
    void fetchFn('/api/profiles')
      .then(async (res) => (res.ok ? ((await res.json()) as Profile[]) : []))
      .then((list) => {
        if (cancelled) return;
        setProfiles(list.map(toProfileOption));
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  const formProfiles = profiles.length > 0 ? profiles : MOCK_PROFILES;

  // Sidebar fetcher built from the injected fetch, so App-level tests drive the
  // sidebar with the SAME mock as the profiles list (no global.fetch reliance).
  const fetchSidebarSessions = useMemo(
    () =>
      async (profileId: string): Promise<SidebarSession[]> => {
        const res = await fetchFn(`/api/profiles/${profileId}/sessions`);
        if (!res.ok) return [];
        return (await res.json()) as SidebarSession[];
      },
    [fetchFn],
  );

  // Story 1.7: label é PATCH nos metadados (não renomeia a sessão tmux).
  const handleRenameSession = async (sessionId: number, label: string): Promise<void> => {
    await fetchFn(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
  };

  /**
   * Recebe cada `session:created` e adiciona o tile. Quando o ack é DESCARTADO
   * como duplicata (mesma sessão já aberta), fecha o canal recém-cunhado —
   * sem isso o canal fica órfão no servidor segurando um attach de tmux, e a
   * conexão da VPS estoura o MaxSessions do sshd (visto em campo, 2026-07-14).
   */
  // O App é o dono PERMANENTE dos acks de criação: o SessionForm agora vive num
  // diálogo desmontado na maior parte do tempo, e acks de reabertura via sidebar
  // chegam sem nenhum form montado. Assinar aqui garante que todo ack vira tile
  // (ou tem seu canal fechado, se duplicado).
  useEffect(() => {
    return ws.subscribe((message) => {
      if (message.type !== 'session:created') return;
      // Rótulo da aba: "vps2letras-projeto-tema-n" (ex. "az-prana-auto-1") —
      // as abas misturam VPS, então levam o contexto completo; o CLI fica de
      // fora (decisão de produto 2026-07-15). Perfil desconhecido → sem prefixo.
      const profileName = profiles.find((p) => p.id === message.profileId)?.label ?? '';
      const vps2 = profileName.trim().slice(0, 2).toLowerCase();
      const tabLabel = [vps2, message.project, message.label]
        .filter((s) => s && s.length > 0)
        .join('-')
        .toLowerCase();
      if (!addTileFromAck(message, tabLabel || undefined)) {
        ws.send({ type: 'channel:close', channelId: message.channelId, reason: 'duplicate tile' });
      }
    });
  }, [ws, addTileFromAck, profiles]);

  // Sessão criada com sucesso enquanto o diálogo está aberto = cumpriu o papel.
  const handleSessionCreated = (): void => {
    setSessionDialogOpen(false);
  };

  // Fechar ABA = detach do cockpit: remove o tile e fecha o canal SSH dele
  // (sem channel:close o canal fica órfão attachado no tmux — lição de
  // 2026-07-14). A sessão tmux segue viva na VPS; reabre pela sidebar.
  const handleCloseTile = (tile: { channelId: string; sessionName: string; profileId: string }): void => {
    ws.send({ type: 'channel:close', channelId: tile.channelId, reason: 'tile closed' });
    removeTile(tile.profileId, tile.sessionName);
  };

  // Story 1.7: delete mata a sessão tmux na VPS (server-side killSession com
  // guard ckpt-) e remove o tile aberto correspondente — escopado por perfil,
  // pois o MESMO nome de sessão pode estar aberto em outra VPS.
  const handleDeleteSession = async (
    profileId: string,
    sessionId: number,
    sessionName: string,
  ): Promise<void> => {
    const res = await fetchFn(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (res.ok) removeTile(profileId, sessionName);
  };

  /**
   * Opening a session from the sidebar = attach-or-create the EXACT named session
   * via the SAME `session:create` path SessionForm uses (no new mechanism). The
   * project/agent/n are derived from the clicked session name (UX-001 discipline).
   */
  /**
   * Estar num painel visível = "eu vi" (2026-07-29). Consome a marca de
   * "respondeu e você não olhou" das sessões nos painéis — tanto ao trazer uma
   * aba ao painel quanto quando a resposta chega numa aba que já estava aberta
   * (nesse caso ela nunca chega a piscar, que é o comportamento desejado: não
   * marcar o que está na frente do operador).
   */
  useEffect(() => {
    for (const channelId of visibleIds) {
      const tile = tiles.find((t) => t.channelId === channelId);
      if (tile) watcher.markSeen(tile.profileId, tile.sessionName);
    }
  }, [visibleIds, tiles, watcher.markSeen, watcher.hasResponded]);

  /**
   * A sessão já tem tile aberto neste browser? Escopado por (perfil, nome): o
   * MESMO nome em outra VPS é outra sessão. Alimenta a sidebar (verde = plugado)
   * e o guard anti-tile-duplicado abaixo — uma definição só para os dois.
   */
  const isSessionOpen = useCallback(
    (profileId: string, sessionName: string): boolean =>
      tiles.some((t) => t.profileId === profileId && t.sessionName === sessionName),
    [tiles],
  );

  const handleOpenSession = (profileId: string, sessionName: string): void => {
    // SMK-007 (smoke E2E): sessão já aberta no grid → não cria outro canal/tile
    // duplicado; cada clique repetido na sidebar abria mais um tile da MESMA
    // sessão tmux. Escopado por perfil: o mesmo nome em OUTRA VPS é uma sessão
    // diferente e deve abrir. (Focar/promover o tile existente fica como refinamento.)
    if (isSessionOpen(profileId, sessionName)) return;
    const parsed = parseSessionName(sessionName);
    if (parsed) {
      // Story 2.12: o nome é `ckpt-<projeto>-<assunto>-<n>`, então quem o
      // reconstrói do lado do server é `pauta` (o assunto) — não o agente.
      // Enviar o agente aqui recriaria um nome diferente do clicado.
      ws.send({
        type: 'session:create',
        profileId,
        projeto: parsed.projeto,
        pauta: parsed.assunto,
        agente: '',
        n: parsed.n,
      });
    }
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1>Prana OPS</h1>
        {/* Story 2.6 (AC4): badge PERSISTENTE no header (visível no dashboard
            e no settings) com a contagem de pending; zero = sem badge. Abre o
            painel de decisões (AC5). */}
        {watcher.pendingCount > 0 && (
          <button
            type="button"
            className="app__decisions-badge"
            aria-label={`${watcher.pendingCount} decisões pendentes`}
            title="Fila de decisões"
            onClick={() => setDecisionsPanelOpen((open) => !open)}
          >
            {watcher.pendingCount}
          </button>
        )}
        {/* Controles do grid no header (2026-07-15): as barras acima do grid
            custavam altura de terminal. Só no dashboard. */}
        {view === 'dashboard' && (
          <GridControls
            tiles={tiles}
            layout={layout}
            visibleIds={visibleIds}
            activeIndex={activeIndex}
            onLayoutChange={setLayout}
            onPromote={promoteToActiveSlot}
            onCloseTile={handleCloseTile}
            getWatcherState={watcher.stateOf}
            getCoverage={coverageOf}
            hasResponded={watcher.hasResponded}
          />
        )}
        <nav className="app__nav" aria-label="Navegação">
          <button
            type="button"
            className={view === 'dashboard' ? 'app__nav-btn app__nav-btn--active' : 'app__nav-btn'}
            aria-current={view === 'dashboard'}
            onClick={() => setView('dashboard')}
          >
            Console
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'app__nav-btn app__nav-btn--active' : 'app__nav-btn'}
            aria-current={view === 'settings'}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      {/* Console stays mounted (display:none when Settings is shown) so open
          tiles/sockets survive navigation — the TerminalGrid pattern from 1.4. */}
      <main className="app__main" style={view === 'dashboard' ? undefined : { display: 'none' }}>
        <aside className={sidebarCollapsed ? 'app__panel app__panel--collapsed' : 'app__panel'}>
          <button
            type="button"
            className="app__panel-toggle"
            aria-label={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
            title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
          {sidebarCollapsed ? (
            <button
              type="button"
              className="app__new-session-btn app__new-session-btn--compact"
              aria-label="Nova sessão"
              title="Nova sessão"
              onClick={() => setSessionDialogOpen(true)}
            >
              +
            </button>
          ) : (
            <>
              <button
                type="button"
                className="app__new-session-btn"
                onClick={() => setSessionDialogOpen(true)}
              >
                + Nova sessão
              </button>
              <Sidebar
                profiles={formProfiles}
                onOpenSession={handleOpenSession}
                fetchSessions={fetchSidebarSessions}
                refreshKey={tiles.length}
                onRenameSession={handleRenameSession}
                onDeleteSession={handleDeleteSession}
                getWatcherState={watcher.stateOf}
                watcherAvailable={watcher.watcherAvailable}
                getWatcherItem={watcher.stateItemOf}
                pipeUnrecoverable={watcher.pipeUnrecoverable}
                agentWithoutHooks={watcher.agentWithoutHooks}
                hooksUnsupported={watcher.hooksUnsupported}
                isSessionOpen={isSessionOpen}
              />
            </>
          )}
        </aside>
        <section className="app__grid">
          <TerminalGrid
            tiles={tiles}
            layout={layout}
            ws={ws}
            visibleIds={visibleIds}
            activeIndex={activeIndex}
            onActivateSlot={activateSlot}
            {...(createTerminal ? { createTerminal } : {})}
          />
        </section>
      </main>

      {view === 'settings' && (
        <main className="app__settings">
          <Settings fetchFn={fetchFn} ws={ws} />
        </main>
      )}

      {/* Story 2.6 (AC5): painel da fila — abre pelo badge, fecha no ✕. As
          ações viram decisions:action; o item some/atualiza quando o
          decisions:update do re-poll chega (watcher é a fonte de verdade). */}
      {decisionsPanelOpen && (
        <DecisionsPanel
          decisions={watcher.decisions}
          profileLabel={(profileId) =>
            profiles.find((p) => p.id === profileId)?.label ?? `VPS ${profileId}`
          }
          onAction={watcher.applyAction}
          onClose={() => setDecisionsPanelOpen(false)}
          onRespond={watcher.respond}
          challengeFor={watcher.challengeFor}
          onCancelChallenge={watcher.clearChallenge}
          resultFor={watcher.resultFor}
        />
      )}

      {/* Diálogo de criação de sessão (o form saiu da sidebar). Overlay fecha
          no clique fora ou no ✕; criação com sucesso fecha via handleSessionCreated. */}
      {sessionDialogOpen && (
        <div
          className="app__dialog-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSessionDialogOpen(false);
          }}
        >
          <div className="app__dialog" role="dialog" aria-label="Nova sessão">
            <button
              type="button"
              className="app__dialog-close"
              aria-label="Fechar diálogo"
              onClick={() => setSessionDialogOpen(false)}
            >
              ✕
            </button>
            <SessionForm ws={ws} onSessionCreated={handleSessionCreated} profiles={formProfiles} />
          </div>
        </div>
      )}
    </div>
  );
}
