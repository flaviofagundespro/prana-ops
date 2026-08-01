/**
 * App integration test (Story 1.4 + Story 1.6).
 *
 * Story 1.4: the App composes SessionForm + TerminalGrid over ONE shared ws;
 * creating a session makes a tile appear keyed by the server-minted channelId.
 *
 * Story 1.6 additions:
 *  - real profiles fetched via GET /api/profiles reach SessionForm (AC6);
 *  - an empty profile list does not break the form;
 *  - Dashboard ↔ Settings navigation without a router (AC9): Settings shows/hides,
 *    and the Dashboard (grid) stays MOUNTED behind display:none — tiles survive.
 *
 * A fake ws and a mocked fetch are injected so no real socket/network is used.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act, waitFor } from '@testing-library/react';
import { App } from './App.js';
import type { WsClient, WsMessageListener } from './lib/ws-client.js';
import type { ClientToServerMessage, ServerToClientMessage } from './ws-protocol.js';
import type { CreateTerminal, TileTerminal } from './components/TerminalTile.js';

/** Fake terminal so App tests never touch real xterm/canvas. */
const fakeTerminal: CreateTerminal = (): TileTerminal => ({
  onData: () => ({ dispose: () => {} }),
  write: () => {},
  open: () => {},
  dispose: () => {},
  fit: () => ({ cols: 80, rows: 24 }),
});

function makeFakeWs(): WsClient & {
  sent: ClientToServerMessage[];
  push: (m: ServerToClientMessage) => void;
} {
  const sent: ClientToServerMessage[] = [];
  const listeners = new Set<WsMessageListener>();
  return {
    sent,
    push: (m) => listeners.forEach((l) => l(m)),
    send: (m) => sent.push(m),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/**
 * Fetch mock. Requisições que o teste não observa ficam pendentes: resolver
 * imediatamente disparava effects assíncronos depois da asserção/cleanup e
 * escondia regressões reais numa enxurrada de warnings de `act(...)`.
 */
type FetchMockOptions = { pendingProfiles?: boolean };

function makeFetch(
  profiles: unknown[],
  { pendingProfiles = profiles.length === 0 }: FetchMockOptions = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/profiles' && !pendingProfiles) return jsonResponse(profiles);
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
}

afterEach(cleanup);

describe('App (Story 1.4 + 1.6 integration)', () => {
  it('renders the header and opens the session dialog via "+ Nova sessão"', async () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);
    expect(screen.getByText('Prana OPS')).toBeInTheDocument();
    // O form saiu da sidebar: só existe depois de abrir o diálogo.
    expect(screen.queryByRole('form', { name: 'Criar sessão' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Nova sessão' }));
    expect(screen.getByRole('dialog', { name: 'Nova sessão' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Criar sessão' })).toBeInTheDocument();
  });

  it('spawns a grid tile when a session is created via the dialog (and closes it)', () => {
    const ws = makeFakeWs();
    const { container } = render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '+ Nova sessão' }));
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'cockpit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'session:create', projeto: 'cockpit' }),
    );

    act(() => {
      ws.push({
        type: 'session:created',
        profileId: '1',
        sessionName: 'ckpt-cockpit-claude-1',
        channelId: 'p1:42',
        project: '',
        label: '',
      });
    });

    const tiles = container.querySelectorAll('.terminal-tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0].getAttribute('data-channel-id')).toBe('p1:42');
    // Criação com sucesso fecha o diálogo.
    expect(screen.queryByRole('dialog', { name: 'Nova sessão' })).not.toBeInTheDocument();
  });

  it('closing a tab removes the tile AND closes its channel (session stays on the VPS)', () => {
    const ws = makeFakeWs();
    const { container } = render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-equipe-claude-1', channelId: 'p1:9', project: '', label: '' });
    });
    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Fechar aba ckpt-equipe-claude-1'));

    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(0);
    // O canal é fechado — sem isso ele ficaria órfão attachado no tmux.
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'channel:close', channelId: 'p1:9' }),
    );
  });

  it('opens BOTH tiles when the same session name exists on two profiles (cross-VPS)', () => {
    // Colisão cross-VPS (campo, 2026-07-14): tmux tem namespace POR HOST — o
    // mesmo ckpt-* em duas VPS são duas sessões distintas; o dedupe global por
    // sessionName engolia o tile da segunda VPS em silêncio.
    const ws = makeFakeWs();
    const { container } = render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-equipe-claude-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({ type: 'session:created', profileId: '3', sessionName: 'ckpt-equipe-claude-1', channelId: 'p3:1', project: '', label: '' });
    });

    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(2);
    // Nenhum channel:close: os dois acks viraram tiles legítimos.
    expect(ws.sent.filter((m) => m.type === 'channel:close')).toHaveLength(0);
  });

  it('closes the orphan channel when a duplicate ack (same profile+session) is dropped', () => {
    // Cada ack descartado carregava um canal recém-cunhado que ficava órfão no
    // servidor segurando um attach de tmux — acumulados, estouravam o
    // MaxSessions do sshd e nenhum canal novo abria (recaída do SMK-002).
    const ws = makeFakeWs();
    const { container } = render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-equipe-claude-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-equipe-claude-1', channelId: 'p1:2', project: '', label: '' });
    });

    // O tile existente permanece o dono (SMK-007)…
    const tiles = container.querySelectorAll('.terminal-tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0].getAttribute('data-channel-id')).toBe('p1:1');
    // …e o canal do ack descartado é fechado (não vaza no servidor).
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'channel:close', channelId: 'p1:2' }),
    );
  });

  it('composes the tab label as vps2-projeto-tema-n from the ack + profile name', async () => {
    const ws = makeFakeWs();
    const fetchFn = makeFetch([{ id: 3, name: 'azure', host: '10.0.0.1', port: 22, user: 'u', keyPath: '/k' }]);
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={fetchFn} />);
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'azure' }).length).toBeGreaterThan(0),
    );

    act(() => {
      ws.push({
        type: 'session:created',
        profileId: '3',
        sessionName: 'ckpt-prana-codex-1',
        channelId: 'p3:7',
        project: 'prana',
        label: 'auto-1',
      });
    });

    expect(screen.getByRole('tab', { name: 'az-prana-auto-1' })).toBeInTheDocument();
  });

  it('collapses and expands the left panel (menu recolhível)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    // Expandido: sidebar de sessões visível.
    expect(screen.getByRole('navigation', { name: 'Sessões por VPS' })).toBeInTheDocument();

    // Recolhe: sidebar some, sobra o trilho com expandir + criar sessão compacto.
    fireEvent.click(screen.getByRole('button', { name: 'Recolher menu' }));
    expect(screen.queryByRole('navigation', { name: 'Sessões por VPS' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nova sessão' })).toBeInTheDocument();

    // Expande de volta.
    fireEvent.click(screen.getByRole('button', { name: 'Expandir menu' }));
    expect(screen.getByRole('navigation', { name: 'Sessões por VPS' })).toBeInTheDocument();
  });

  it('does not create a real WebSocket when a ws is injected', () => {
    const ws = makeFakeWs();
    expect(() =>
      render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />),
    ).not.toThrow();
  });

  it('fetches real profiles and passes them to SessionForm (AC6)', async () => {
    const ws = makeFakeWs();
    const fetchFn = makeFetch([{ id: 7, name: 'azure', host: '10.0.0.1', port: 22, user: 'u', keyPath: '/k' }]);
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={fetchFn} />);

    // The profile option reaches the sidebar dropdown AND (via dialog) the
    // SessionForm select (id→string, "name (host)") — 2 selects, 2 options.
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'azure' }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Nova sessão' }));
    expect(screen.getAllByRole('option', { name: 'azure' })).toHaveLength(2);
  });

  it('empty profile list does not break the form (AC6)', async () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([], { pendingProfiles: false })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Nova sessão' })).toBeEnabled());
    // Falls back to MOCK_PROFILES so the form (no diálogo) stays usable.
    fireEvent.click(screen.getByRole('button', { name: '+ Nova sessão' }));
    expect(screen.getByRole('form', { name: 'Criar sessão' })).toBeInTheDocument();
  });

  it('badge de decisões: aparece com a contagem de pending; zero = sem badge (Story 2.6, AC4)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    // Sem decisões: sem badge.
    expect(screen.queryByLabelText(/decisões pendentes/)).not.toBeInTheDocument();

    act(() => {
      ws.push({
        type: 'decisions:update',
        profileId: '1',
        watcherAvailable: true,
        decisions: [
          { id: 3, sessionName: 'ckpt-a-claude-1', summary: 'Aprovar?', risk: 'high', status: 'pending', updatedAt: '2026-07-16 11:00:00.000' },
          { id: 4, sessionName: 'ckpt-b-claude-1', summary: 'Vista', risk: 'low', status: 'seen', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    // Badge conta SÓ pending (1, não 2).
    const badge = screen.getByLabelText('1 decisões pendentes');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('1');

    // Fila esvaziou → badge some.
    act(() => {
      ws.push({ type: 'decisions:update', profileId: '1', watcherAvailable: true, decisions: [] });
    });
    expect(screen.queryByLabelText(/decisões pendentes/)).not.toBeInTheDocument();
  });

  it('painel abre pelo badge e a ação dispara decisions:action no ws (Story 2.6, AC5)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({
        type: 'decisions:update',
        profileId: '1',
        watcherAvailable: true,
        decisions: [
          { id: 3, sessionName: 'ckpt-a-claude-1', summary: 'Aprovar deploy?', risk: 'high', status: 'pending', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    fireEvent.click(screen.getByLabelText('1 decisões pendentes'));
    expect(screen.getByRole('dialog', { name: 'Fila de decisões' })).toBeInTheDocument();
    expect(screen.getByText('Aprovar deploy?')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Descartar decisão 3'));
    expect(ws.sent).toContainEqual({
      type: 'decisions:action',
      profileId: '1',
      decisionId: 3,
      action: 'dismissed',
    });
  });

  it('aba do grid mostra o estado real do watcher, waiting_for_input saliente (Story 2.6, AC6)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-a-claude-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [
          { sessionName: 'ckpt-a-claude-1', state: 'waiting_for_input', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    const dot = screen.getByLabelText('estado: waiting_for_input');
    expect(dot.className).toContain('grid-tab-state--waiting_for_input');
    // 2026-07-29: o âmbar é da ABA INTEIRA — como ponto sobre a aba mostarda
    // (então visível) ele sumia justamente na aba que o operador está olhando.
    expect(dot.closest('button')?.className).toContain('grid-tab--waiting');
  });

  it('aba visível SEM waiting não recebe o âmbar (verde = "estou aqui") (2026-07-29)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-a-claude-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [
          { sessionName: 'ckpt-a-claude-1', state: 'thinking', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    const tab = screen.getByLabelText('estado: thinking').closest('button');
    expect(tab?.className).toContain('grid-tab--current');
    expect(tab?.className).not.toContain('grid-tab--waiting');
    // A aba visível é pintada pelo ESTADO — thinking = azul (2026-07-29).
    expect(tab?.className).toContain('grid-tab--thinking');
  });

  it('thinking visível preenche e thinking oculta mantém moldura azul (Story 2.18)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      // Layout default = 4 painéis, então a 5ª aba é a que fica oculta.
      for (let n = 1; n <= 5; n += 1) {
        ws.push({ type: 'session:created', profileId: '1', sessionName: `ckpt-a-claude-${n}`, channelId: `p1:${n}`, project: '', label: '' });
      }
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [1, 2, 3, 4, 5].map((n) => ({
          sessionName: `ckpt-a-claude-${n}`,
          state: 'thinking' as const,
          updatedAt: '2026-07-16 11:00:00.000',
        })),
      });
    });

    const tabs = screen.getAllByLabelText('estado: thinking').map((d) => d.closest('button'));
    // Todas as abas em thinking recebem a marca (moldura na oculta, fundo na
    // visível) — a bolinha sozinha não respondia "ainda está trabalhando?".
    expect(tabs.every((t) => t?.className.includes('grid-tab--thinking'))).toBe(true);
    // Mas o PREENCHIMENTO segue exclusivo da visível: é ele que diz "onde estou".
    const visible = tabs.filter((t) => t?.className.includes('grid-tab--current'));
    expect(visible.length).toBeLessThan(tabs.length);
  });

  it('thinking→idle não cria estado local de lido/concluído (Story 2.18)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      for (let n = 1; n <= 5; n += 1) {
        ws.push({ type: 'session:created', profileId: '1', sessionName: `ckpt-a-claude-${n}`, channelId: `p1:${n}`, project: '', label: '' });
      }
      // Todas pensando: a 5ª é a oculta (layout default = 4 painéis).
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [1, 2, 3, 4, 5].map((n) => ({
          sessionName: `ckpt-a-claude-${n}`,
          state: 'thinking' as const,
          updatedAt: '2026-07-16 11:00:00.000',
        })),
      });
    });

    act(() => {
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [1, 2, 3, 4, 5].map((n) => ({
          sessionName: `ckpt-a-claude-${n}`,
          state: 'idle' as const,
          updatedAt: '2026-07-16 11:00:05.000',
        })),
      });
    });

    expect(screen.queryByLabelText(/respondeu|não viu|concluído/i)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('estado: idle')).toHaveLength(5);
  });

  it('⃠ no_hooks bloqueia azul heurístico mesmo quando o estado diz thinking (Story 2.18)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-legado-codex-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        sessionsWithoutHooks: ['ckpt-legado-codex-1'],
        states: [
          { sessionName: 'ckpt-legado-codex-1', state: 'thinking', updatedAt: '2026-07-31 22:29:58.448' },
        ],
      });
    });

    const tab = screen.getByLabelText('estado: thinking').closest('button');
    expect(screen.getByLabelText(/^sem sinal:/)).toBeInTheDocument();
    expect(tab?.className).not.toContain('grid-tab--thinking');
  });

  it('waiting é a exceção: pinta MESMO oculta (2026-07-29)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      for (let n = 1; n <= 5; n += 1) {
        ws.push({ type: 'session:created', profileId: '1', sessionName: `ckpt-a-claude-${n}`, channelId: `p1:${n}`, project: '', label: '' });
      }
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [
          // A 5ª é a oculta (layout default = 4 painéis).
          { sessionName: 'ckpt-a-claude-5', state: 'waiting_for_input', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    const tab = screen.getByLabelText('estado: waiting_for_input').closest('button');
    expect(tab?.className).toContain('grid-tab--waiting');
    // Oculta e ainda assim âmbar — é o ponto todo do sinal.
    expect(tab?.className).not.toContain('grid-tab--current');
  });

  it('estado do watcher é escopado por perfil — sem vazamento cross-VPS (Story 2.6, AC7)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      // MESMO nome de sessão em duas VPS; só a VPS 1 está waiting.
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-a-claude-1', channelId: 'p1:1', project: '', label: '' });
      ws.push({ type: 'session:created', profileId: '3', sessionName: 'ckpt-a-claude-1', channelId: 'p3:1', project: '', label: '' });
      ws.push({
        type: 'sessions:state',
        profileId: '1',
        watcherAvailable: true,
        states: [
          { sessionName: 'ckpt-a-claude-1', state: 'waiting_for_input', updatedAt: '2026-07-16 11:00:00.000' },
        ],
      });
    });

    // Exatamente UM indicador: a aba da VPS 3 não herda o estado da VPS 1.
    expect(screen.getAllByLabelText('estado: waiting_for_input')).toHaveLength(1);
  });

  it('responder low: envia decisions:respond sem token direto do painel (Story 2.7, AC1)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({
        type: 'decisions:update', profileId: '1', watcherAvailable: true,
        decisions: [{ id: 3, sessionName: 'ckpt-a-claude-1', summary: 'Qual abordagem?', risk: 'low', status: 'pending', updatedAt: '2026-07-16 11:00:00.000' }],
      });
    });

    fireEvent.click(screen.getByLabelText('1 decisões pendentes'));
    fireEvent.click(screen.getByLabelText('Responder sim à decisão 3'));

    expect(ws.sent).toContainEqual({
      type: 'decisions:respond', profileId: '1', decisionId: 3,
      sessionName: 'ckpt-a-claude-1', text: 'y',
    });
  });

  it('responder high: challenge do server mostra comando exato; confirmar reenvia com token (Story 2.7, AC4)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({
        type: 'decisions:update', profileId: '1', watcherAvailable: true,
        decisions: [{ id: 5, sessionName: 'ckpt-a-claude-1', summary: 'Aplicar migration?', risk: 'high', status: 'pending', updatedAt: '2026-07-16 11:00:00.000' }],
      });
    });

    fireEvent.click(screen.getByLabelText('1 decisões pendentes'));
    // Texto livre + enviar → 1º round-trip (sem token).
    const input = screen.getByLabelText('Resposta livre para a decisão 5');
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.click(screen.getByLabelText('Enviar resposta livre à decisão 5'));
    expect(ws.sent).toContainEqual({
      type: 'decisions:respond', profileId: '1', decisionId: 5, sessionName: 'ckpt-a-claude-1', text: 'y',
    });

    // Server devolve o challenge com o comando exato + token.
    const command = `tmux send-keys -l -t 'ckpt-a-claude-1' -- 'y' && tmux send-keys -t 'ckpt-a-claude-1' Enter`;
    act(() => {
      ws.push({
        type: 'decisions:respond:challenge', profileId: '1', decisionId: 5,
        sessionName: 'ckpt-a-claude-1', command, confirmToken: 'tok-77',
      });
    });
    expect(screen.getByText(command)).toBeInTheDocument();

    // Confirmar reenvia o MESMO texto ('y') AGORA com o token de uso único.
    fireEvent.click(screen.getByLabelText('Confirmar e enviar resposta à decisão 5'));
    expect(ws.sent).toContainEqual({
      type: 'decisions:respond', profileId: '1', decisionId: 5,
      sessionName: 'ckpt-a-claude-1', text: 'y', confirmToken: 'tok-77',
    });
  });

  it('responder falha honesta: erro do server aparece e a decisão fica na fila (Story 2.7, AC7)', () => {
    const ws = makeFakeWs();
    render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    act(() => {
      ws.push({
        type: 'decisions:update', profileId: '1', watcherAvailable: true,
        decisions: [{ id: 3, sessionName: 'ckpt-a-claude-1', summary: 'x', risk: 'low', status: 'pending', updatedAt: '2026-07-16 11:00:00.000' }],
      });
    });
    fireEvent.click(screen.getByLabelText('1 decisões pendentes'));
    fireEvent.click(screen.getByLabelText('Responder sim à decisão 3'));

    act(() => {
      ws.push({
        type: 'decisions:respond:result', profileId: '1', decisionId: 3, ok: false,
        message: 'send-keys não confirmado (sessão morta)',
      });
    });

    expect(screen.getByText('send-keys não confirmado (sessão morta)')).toBeInTheDocument();
    // Badge/decisão continuam — nada saiu da fila.
    expect(screen.getByLabelText('1 decisões pendentes')).toBeInTheDocument();
  });

  it('navigates Dashboard ↔ Settings without unmounting the grid (AC9)', () => {
    const ws = makeFakeWs();
    const { container } = render(<App ws={ws} createTerminal={fakeTerminal} fetchFn={makeFetch([])} />);

    // Create a tile so we can prove it survives navigation.
    fireEvent.click(screen.getByRole('button', { name: '+ Nova sessão' }));
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'cockpit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));
    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-cockpit-claude-1', channelId: 'p1:1', project: '', label: '' });
    });
    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(1);

    // Go to Settings.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('form', { name: 'Ambiente' })).toBeInTheDocument();
    // Dashboard is hidden (display:none), NOT unmounted — the tile is still there.
    const dashboard = container.querySelector('.app__main') as HTMLElement;
    expect(dashboard.style.display).toBe('none');
    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(1);

    // Back to Dashboard.
    fireEvent.click(screen.getByRole('button', { name: 'Console' }));
    expect(dashboard.style.display).toBe('');
    expect(container.querySelectorAll('.terminal-tile')).toHaveLength(1);
  });
});
