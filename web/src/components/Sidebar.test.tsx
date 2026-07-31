/**
 * Sidebar tests (Story 1.6, Task 3, AC1/AC10/AC12).
 *
 * - groups sessions by profile → project (multiple profiles, multiple projects);
 * - clicking a session item calls onOpenSession(profileId, sessionName) exactly;
 * - a profile with no known sessions still appears (header visible, empty body);
 * - status is rendered via toSidebarStatus (active→idle, error→error).
 *
 * `fetch` is INJECTED as a prop mock (not global.fetch) — the DI pattern the story
 * mandates to avoid fragile global mocking.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Sidebar, type SidebarSession, type SessionsFetcher } from './Sidebar.js';
import type { ProfileOption } from './SessionForm.js';
import type { SessionStateItem } from '../ws-protocol.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const profiles: ProfileOption[] = [
  { id: '1', label: 'azure' },
  { id: '2', label: 'host-b' },
];

function fetcherFor(map: Record<string, SidebarSession[]>): SessionsFetcher {
  return vi.fn(async (profileId: string) => map[profileId] ?? []);
}

describe('Sidebar (AC1/AC10)', () => {
  it('shows ONLY the selected VPS; the dropdown switches profiles', async () => {
    // Feedback do uso diário (2026-07-15): listar todas as VPS de uma vez
    // poluía a sidebar — o dropdown mostra uma VPS por vez (default: a 1ª).
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-codex-2', status: 'error' },
        { id: 3, profileId: 1, project: 'infra', sessionName: 'ckpt-infra-claude-1', status: 'active' },
      ],
      '2': [
        { id: 4, profileId: 2, project: 'site', sessionName: 'ckpt-site-claude-1', status: 'active' },
      ],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());

    // Default: primeira VPS (azure) — projetos dela visíveis, os da host-b NÃO.
    expect(screen.getByLabelText('Sessões de cockpit')).toBeInTheDocument();
    expect(screen.getByLabelText('Sessões de infra')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sessões de site')).not.toBeInTheDocument();

    // cockpit group has exactly two sessions.
    const cockpit = screen.getByLabelText('Sessões de cockpit');
    expect(within(cockpit).getAllByRole('listitem')).toHaveLength(2);

    // Troca no dropdown → só a host-b aparece.
    fireEvent.change(screen.getByLabelText('VPS'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByLabelText('Sessões de site')).toBeInTheDocument());
    expect(screen.queryByLabelText('Sessões de cockpit')).not.toBeInTheDocument();
  });

  it('remembers the selected VPS across mounts (persisted preference)', async () => {
    // Stub em memória: o ambiente de teste não fornece localStorage completo.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const fetchSessions = fetcherFor({
      '1': [{ id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' }],
      '2': [{ id: 4, profileId: 2, project: 'site', sessionName: 'ckpt-site-claude-1', status: 'active' }],
    });
    const first = render(
      <Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Sessões de cockpit')).toBeInTheDocument());

    // Seleciona a 2ª VPS e desmonta (fim de "visita").
    fireEvent.change(screen.getByLabelText('VPS'), { target: { value: '2' } });
    first.unmount();

    // Nova montagem: abre direto na VPS preferida (a última usada).
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);
    await waitFor(() => expect(screen.getByLabelText('Sessões de site')).toBeInTheDocument());
    expect((screen.getByLabelText('VPS') as HTMLSelectElement).value).toBe('2');
  });

  it('calls onOpenSession with (profileId, sessionName) on click', async () => {
    const onOpenSession = vi.fn();
    const fetchSessions = fetcherFor({
      '1': [{ id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' }],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={onOpenSession} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ckpt-cockpit-claude-1'));

    expect(onOpenSession).toHaveBeenCalledWith('1', 'ckpt-cockpit-claude-1');
  });

  it('shows a profile with no sessions (header visible, empty body)', async () => {
    const fetchSessions = fetcherFor({
      '1': [{ id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' }],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    // host-b header exists but has no session items.
    expect(screen.getByText('host-b')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sessões de site')).not.toBeInTheDocument();
  });

  it('renders status via toSidebarStatus (active→idle, error→error)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-codex-2', status: 'error' },
      ],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    expect(screen.getByLabelText('status: idle')).toBeInTheDocument();
    expect(screen.getByLabelText('status: error')).toBeInTheDocument();
  });

  it('estado do watcher REFINA o liveness; waiting_for_input destacado (Story 2.6, AC6)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-codex-2', status: 'active' },
        // Morta no tmux ls: o error da Fase 1 vence qualquer estado do watcher (F9).
        { id: 3, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-3', status: 'error' },
      ],
      '2': [],
    });
    const states: Record<string, 'thinking' | 'waiting_for_input'> = {
      'ckpt-cockpit-claude-1': 'waiting_for_input',
      'ckpt-cockpit-codex-2': 'thinking',
      'ckpt-cockpit-claude-3': 'thinking',
    };
    render(
      <Sidebar
        profiles={profiles}
        onOpenSession={() => {}}
        fetchSessions={fetchSessions}
        getWatcherState={(profileId, name) => (profileId === '1' ? states[name] : undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    const waiting = screen.getByLabelText('status: waiting_for_input');
    expect(waiting.className).toContain('sidebar__status--waiting_for_input');
    expect(screen.getByLabelText('status: thinking')).toBeInTheDocument();
    // A sessão morta continua error — o watcher refina, não substitui.
    expect(screen.getByLabelText('status: error')).toBeInTheDocument();
  });

  it('projetos em ordem alfabética, "Sem projeto" por último (2026-07-29)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'Acme', sessionName: 'ckpt-acme-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: null, sessionName: 'ckpt-orfa-claude-1', status: 'active' },
        { id: 3, profileId: 1, project: 'Northwind', sessionName: 'ckpt-northwind-claude-1', status: 'active' },
        { id: 4, profileId: 1, project: 'lumen', sessionName: 'ckpt-lumen-claude-1', status: 'active' },
      ],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('Northwind')).toBeInTheDocument());
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    // Alfabética ignorando caixa; o balde sem identidade fica no fim.
    expect(headings).toEqual(['Acme', 'lumen', 'Northwind', 'Sem projeto']);
  });

  it('mesmo projeto com caixa diferente vira UM grupo (azure/Azure) (2026-07-29)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'azure', sessionName: 'ckpt-azure-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: 'Azure', sessionName: 'ckpt-azure-manutencao-2', status: 'active' },
      ],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-azure-claude-1')).toBeInTheDocument());
    const headings = screen.getAllByRole('heading', { level: 3 });
    // Um cabeçalho só, com a grafia da PRIMEIRA ocorrência; ambas as sessões nele.
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('azure');
    expect(screen.getByLabelText('Sessões de azure').querySelectorAll('li')).toHaveLength(2);
  });

  it('verde só para sessão ABERTA no cockpit; idle fechado dessatura (2026-07-29)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
        { id: 2, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-codex-2', status: 'active' },
      ],
      '2': [],
    });
    render(
      <Sidebar
        profiles={profiles}
        onOpenSession={() => {}}
        fetchSessions={fetchSessions}
        isSessionOpen={(profileId, name) => profileId === '1' && name === 'ckpt-cockpit-claude-1'}
      />,
    );

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    const badges = screen.getAllByLabelText('status: idle');
    // A aberta mantém o verde; a fechada cai no tom dessaturado.
    expect(badges[0]?.className).toContain('sidebar__status--idle');
    expect(badges[0]?.className).not.toContain('idle-detached');
    expect(badges[1]?.className).toContain('sidebar__status--idle-detached');
  });

  it('estados AFIRMADOS mantêm cor mesmo com a sessão fechada (2026-07-29)', async () => {
    const fetchSessions = fetcherFor({
      '1': [
        { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
      ],
      '2': [],
    });
    render(
      <Sidebar
        profiles={profiles}
        onOpenSession={() => {}}
        fetchSessions={fetchSessions}
        getWatcherState={() => 'waiting_for_input'}
        isSessionOpen={() => false}
      />,
    );

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    const waiting = screen.getByLabelText('status: waiting_for_input');
    // Fechada, mas o âmbar permanece — é o caso que mais precisa ser visto.
    expect(waiting.className).toContain('sidebar__status--waiting_for_input');
    // O rótulo encurta; o estado do protocolo (aria-label/classe) não muda.
    expect(waiting.textContent).toBe('waiting');
  });

  it('watcher indisponível → indicação discreta; sessões caem na Fase 1 (Story 2.6, AC3)', async () => {
    const fetchSessions = fetcherFor({
      '1': [{ id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' }],
      '2': [],
    });
    render(
      <Sidebar
        profiles={profiles}
        onOpenSession={() => {}}
        fetchSessions={fetchSessions}
        getWatcherState={() => undefined}
        watcherAvailable={() => false}
      />,
    );

    await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
    expect(screen.getByText('watcher indisponível')).toBeInTheDocument();
    // Sem sinal do watcher: comportamento Fase 1 exato (active → idle).
    expect(screen.getByLabelText('status: idle')).toBeInTheDocument();
  });

  it('groups sessions with no project under "Sem projeto"', async () => {
    const fetchSessions = fetcherFor({
      '1': [{ id: 1, profileId: 1, project: null, sessionName: 'ckpt-adopted-claude-1', status: 'active' }],
      '2': [],
    });
    render(<Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={fetchSessions} />);

    await waitFor(() => expect(screen.getByText('ckpt-adopted-claude-1')).toBeInTheDocument());
    expect(screen.getByLabelText('Sessões de Sem projeto')).toBeInTheDocument();
  });

  /**
   * Story 2.9 (AC6) — a marca de ausência de sinal. O contrato é que a sidebar
   * deixe de tratar "não sei" como "está calmo": sessão coberta NÃO ganha marca,
   * sessão sem cobertura ganha, e o motivo é legível.
   */
  describe('cobertura — "sem sinal" (Story 2.9)', () => {
    const oneSession = () =>
      fetcherFor({
        '1': [
          { id: 1, profileId: 1, project: 'cockpit', sessionName: 'ckpt-cockpit-claude-1', status: 'active' },
        ],
        '2': [],
      });

    /** Timestamp no formato do watcher, N ms atrás. */
    const ago = (ms: number): string =>
      new Date(Date.now() - ms).toISOString().replace('T', ' ').replace('Z', '');

    function renderWith(item: SessionStateItem | undefined, available = true) {
      return render(
        <Sidebar
          profiles={profiles}
          onOpenSession={() => {}}
          fetchSessions={oneSession()}
          getWatcherState={() => item?.state}
          watcherAvailable={() => available}
          getWatcherItem={() => item}
        />,
      );
    }

    const covered: SessionStateItem = {
      sessionName: 'ckpt-cockpit-claude-1',
      state: 'idle',
      updatedAt: ago(1000),
      stateSince: ago(1000),
    };

    it('sessão vigiada e calma NÃO ganha marca (silêncio informativo)', async () => {
      renderWith(covered);
      await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
      expect(screen.queryByLabelText(/^sem sinal:/)).not.toBeInTheDocument();
    });

    it('watcher não conhece a sessão → marca com motivo legível', async () => {
      renderWith(undefined);
      await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
      const mark = screen.getByLabelText(/^sem sinal:/);
      expect(mark.className).toContain('sidebar__coverage--unknown');
      expect(mark.getAttribute('aria-label')).toContain('não conhece');
    });

    it('perfil sem watcher → marca de no_watcher', async () => {
      renderWith(undefined, false);
      await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
      expect(screen.getByLabelText(/^sem sinal:/).className).toContain('sidebar__coverage--no_watcher');
    });

    it('thinking congelado há horas → marca de stuck com a duração no motivo', async () => {
      renderWith({ ...covered, state: 'thinking', stateSince: ago(3 * 60 * 60 * 1000) });
      await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
      const mark = screen.getByLabelText(/^sem sinal:/);
      expect(mark.className).toContain('sidebar__coverage--stuck');
      expect(mark.getAttribute('aria-label')).toContain('3h');
    });

    it('sem getWatcherItem a sidebar se comporta como antes da 2.9 (prop aditiva)', async () => {
      render(
        <Sidebar profiles={profiles} onOpenSession={() => {}} fetchSessions={oneSession()} />,
      );
      await waitFor(() => expect(screen.getByText('ckpt-cockpit-claude-1')).toBeInTheDocument());
      // Sem watcher REPORTADO não há evidência de ausência — alarmar aqui seria
      // alarmar sobre nada, e marcaria toda sessão antes do primeiro sync.
      expect(screen.queryByLabelText(/^sem sinal:/)).not.toBeInTheDocument();
    });
  });
});
