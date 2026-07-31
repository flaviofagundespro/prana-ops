/**
 * TerminalGrid + GridControls + useGridSlots tests (AC1, AC5, AC10).
 *
 * Desde 2026-07-15 os controles (layouts/abas) vivem no HEADER (GridControls)
 * e o estado de slots no hook useGridSlots — o Harness abaixo espelha a
 * ligação feita pelo App, então os testes cobrem o conjunto integrado:
 * visibilidade por layout, promoção de aba para o painel ATIVO, fechar aba,
 * e o trade-off de manter todos os tiles montados.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useMemo } from 'react';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import { TerminalGrid, type GridTile, type GridLayout } from './TerminalGrid.js';
import { GridControls } from './GridControls.js';
import { useGridSlots } from '../hooks/useGridSlots.js';
import { TerminalTile, type TileTerminal, type CreateTerminal } from './TerminalTile.js';
import type { WsClient } from '../lib/ws-client.js';
import type { BatchScheduler } from '../lib/output-batcher.js';

function makeWs(): WsClient {
  return { send: () => {}, subscribe: () => () => {} };
}

const fakeScheduler: BatchScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const fakeTerminal: CreateTerminal = (): TileTerminal => ({
  onData: () => ({ dispose: () => {} }),
  write: () => {},
  open: () => {},
  dispose: () => {},
  fit: () => ({ cols: 80, rows: 24 }),
});

function tiles(n: number): GridTile[] {
  return Array.from({ length: n }, (_, i) => ({
    channelId: `p1:${i + 1}`,
    sessionName: `ckpt-sess-${i + 1}`,
    profileId: '1',
  }));
}

/** Espelha a ligação do App: hook compartilhado entre controles e grid. */
function Harness({
  tiles: t,
  layout,
  createTerminal = fakeTerminal,
  onCloseTile = () => {},
}: {
  tiles: GridTile[];
  layout: GridLayout;
  createTerminal?: CreateTerminal;
  onCloseTile?: (tile: GridTile) => void;
}): JSX.Element {
  const { visibleIds, activeIndex, activateSlot, promoteToActiveSlot } = useGridSlots(t, layout);
  // ws estável entre re-renders (como no App): identidade nova dispararia a
  // recriação do terminal em cada tile (deps do effect do TerminalTile).
  const ws = useMemo(makeWs, []);
  return (
    <>
      <GridControls
        tiles={t}
        layout={layout}
        visibleIds={visibleIds}
        activeIndex={activeIndex}
        onLayoutChange={() => {}}
        onPromote={promoteToActiveSlot}
        onCloseTile={onCloseTile}
      />
      <TerminalGrid
        tiles={t}
        layout={layout}
        ws={ws}
        visibleIds={visibleIds}
        activeIndex={activeIndex}
        onActivateSlot={activateSlot}
        createTerminal={createTerminal}
        scheduler={fakeScheduler}
      />
    </>
  );
}

function renderGrid(n: number, layout: GridLayout) {
  return render(<Harness tiles={tiles(n)} layout={layout} />);
}

/** Counts tiles that are actually visible (cell not display:none). */
function visibleTiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.terminal-grid-cell[data-visible="true"]'));
}

afterEach(cleanup);

describe('TerminalGrid layout (AC1, AC5)', () => {
  // A barra lista TODAS as sessões — a(s) visível(is) destacada(s)
  // (grid-tab--current, desabilitada), as ocultas clicáveis. Sempre visível
  // com tiles abertos (o ✕ de fechar aba vive nela).
  it.each([
    [1, 6, 1, 6, 1],
    [2, 6, 2, 6, 2],
    [4, 6, 4, 6, 4],
    [6, 6, 6, 6, 6],
  ] as Array<[GridLayout, number, number, number, number]>)(
    'layout %i with %i tiles → %i visible, %i tabs (%i current)',
    (layout, n, expectedVisible, expectedTabs, expectedCurrent) => {
      const { container } = renderGrid(n, layout);
      expect(visibleTiles(container)).toHaveLength(expectedVisible);
      const tablist = container.querySelector('[role="tablist"]');
      const tabs = tablist ? within(tablist as HTMLElement).queryAllByRole('tab') : [];
      expect(tabs).toHaveLength(expectedTabs);
      const current = tabs.filter((t) => t.className.includes('grid-tab--current'));
      expect(current).toHaveLength(expectedCurrent);
    },
  );

  it('renders fewer tiles than layout when there are fewer tiles', () => {
    const { container } = renderGrid(3, 4);
    expect(visibleTiles(container)).toHaveLength(3);
    // Barra presente (todas current, nenhuma clicável — mas o ✕ vive nela).
    const tablist = container.querySelector('[role="tablist"]');
    expect(within(tablist as HTMLElement).getAllByRole('tab')).toHaveLength(3);
  });

  it('mounts EVERY tile even when only some are visible (no unmount on overflow)', () => {
    const { container } = renderGrid(6, 2);
    // 6 tile cells exist in the DOM; only 2 are visible.
    expect(container.querySelectorAll('.terminal-grid-cell')).toHaveLength(6);
    expect(visibleTiles(container)).toHaveLength(2);
  });

  it('each visible tile maps to exactly one distinct channelId (AC5)', () => {
    const { container } = renderGrid(6, 4);
    const ids = visibleTiles(container).map((cell) =>
      cell.querySelector('.terminal-tile')?.getAttribute('data-channel-id'),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });
});

describe('TerminalGrid tabs (AC1, AC10)', () => {
  it('promotes an overflow tile into the grid when its tab is clicked, without remounting others', () => {
    // Spy the terminal factory to count how many times each channel is created.
    const created: string[] = [];
    const spyTerminal: CreateTerminal = () => {
      created.push('t');
      return fakeTerminal();
    };
    const { container } = render(<Harness tiles={tiles(3)} layout={2} createTerminal={spyTerminal} />);

    // 3 tiles mounted once each (all mounted regardless of visibility).
    expect(created).toHaveLength(3);

    const initiallyVisible = visibleTiles(container).map((c) =>
      c.querySelector('.terminal-tile')?.getAttribute('data-channel-id'),
    );
    expect(initiallyVisible).toEqual(['p1:1', 'p1:2']); // overflow: p1:3

    const allTabs = within(container.querySelector('[role="tablist"]') as HTMLElement).getAllByRole(
      'tab',
    );
    const hiddenTab = allTabs.find((t) => !t.className.includes('grid-tab--current'));
    expect(hiddenTab).toBeDefined();
    fireEvent.click(hiddenTab as HTMLElement);

    const afterVisible = visibleTiles(container)
      .map((c) => c.querySelector('.terminal-tile')?.getAttribute('data-channel-id'))
      .sort();
    // p1:3 promoted into the last slot (ativo default), replacing p1:2.
    expect(afterVisible).toEqual(['p1:1', 'p1:3']);

    // No tile was remounted (still 3 total creations).
    expect(created).toHaveLength(3);
  });

  it('swaps into the ACTIVE pane after clicking a pane (split-2, left pane selectable)', () => {
    const { container } = renderGrid(3, 2);

    const orderedVisible = () =>
      visibleTiles(container)
        .sort((a, b) => Number(a.style.order) - Number(b.style.order))
        .map((c) => c.querySelector('.terminal-tile')?.getAttribute('data-channel-id'));
    expect(orderedVisible()).toEqual(['p1:1', 'p1:2']);

    // Click the LEFT pane (slot 0) to make it active…
    const leftCell = visibleTiles(container).find((c) => c.style.order === '0') as HTMLElement;
    fireEvent.mouseDown(leftCell);
    expect(leftCell.className).toContain('terminal-grid-cell--active');

    // …then click the hidden tab: p1:3 must land on the LEFT pane.
    const allTabs = within(container.querySelector('[role="tablist"]') as HTMLElement).getAllByRole('tab');
    const hiddenTab = allTabs.find((t) => !t.className.includes('grid-tab--current'));
    fireEvent.click(hiddenTab as HTMLElement);

    expect(orderedVisible()).toEqual(['p1:3', 'p1:2']);
  });

  it('defaults the active pane to the LAST slot (previous behavior preserved)', () => {
    const { container } = renderGrid(3, 2);
    const activeCells = container.querySelectorAll('.terminal-grid-cell--active');
    expect(activeCells).toHaveLength(1);
    expect((activeCells[0] as HTMLElement).style.order).toBe('1'); // last of 2 slots
  });

  it('shows no active highlight in single-pane layout (nothing to disambiguate)', () => {
    const { container } = renderGrid(3, 1);
    expect(container.querySelectorAll('.terminal-grid-cell--active')).toHaveLength(0);
  });

  it('calls onCloseTile with the tile when its tab ✕ is clicked', () => {
    const closed: string[] = [];
    const { container } = render(
      <Harness tiles={tiles(2)} layout={2} onCloseTile={(t) => closed.push(t.channelId)} />,
    );
    const closeBtn = within(container.querySelector('[role="tablist"]') as HTMLElement).getByLabelText(
      'Fechar aba ckpt-sess-2',
    );
    fireEvent.click(closeBtn);
    expect(closed).toEqual(['p1:2']);
  });
});

/**
 * Mapa aba→painel (2026-07-27). Com 2+ painéis, toda aba visível ficava amarela
 * e o operador não sabia QUAL painel era o dela. O contrato testado aqui não é
 * a aparência do badge, e sim o INVARIANTE: o número mostrado na aba de uma
 * sessão é o mesmo número mostrado no painel que a contém — antes e depois de
 * qualquer swap. Se um refactor quebrar essa correspondência, o teste cai.
 */
describe('TerminalGrid slot mapping (aba ↔ painel)', () => {
  /** channelId → número exibido no painel, lido do DOM. */
  function paneSlots(container: HTMLElement): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cell of visibleTiles(container)) {
      const id = cell.querySelector('.terminal-tile')?.getAttribute('data-channel-id');
      const badge = cell.querySelector('.terminal-grid-slot')?.textContent;
      if (id && badge) out[id] = badge;
    }
    return out;
  }

  /** sessionName → número exibido na aba, lido do DOM. */
  function tabSlots(container: HTMLElement): Record<string, string> {
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    const out: Record<string, string> = {};
    for (const tab of within(tablist).getAllByRole('tab')) {
      const badge = tab.querySelector('.grid-tab-slot')?.textContent;
      const session = tab.textContent?.match(/ckpt-sess-\d+/)?.[0];
      if (session && badge) out[session] = badge;
    }
    return out;
  }

  /** `p1:3` ↔ `ckpt-sess-3` no harness — a ponte entre os dois mapas. */
  const sessionOf = (channelId: string): string => `ckpt-sess-${channelId.split(':')[1]}`;

  function expectTabsMatchPanes(container: HTMLElement): void {
    const panes = paneSlots(container);
    const tabs = tabSlots(container);
    // Só as sessões EM TELA carregam número — nem a mais, nem a menos.
    expect(Object.keys(tabs).sort()).toEqual(Object.keys(panes).map(sessionOf).sort());
    for (const [channelId, paneNumber] of Object.entries(panes)) {
      expect(tabs[sessionOf(channelId)]).toBe(paneNumber);
    }
  }

  it.each([
    [2, 3],
    [4, 6],
    [6, 6],
  ] as Array<[GridLayout, number]>)(
    'layout %i: cada aba visível mostra o número do painel que a contém',
    (layout, n) => {
      const { container } = renderGrid(n, layout);
      expectTabsMatchPanes(container);
      // Numeração é 1..N em ordem de leitura (a mesma que o CSS `order` aplica).
      const expected = Array.from({ length: Math.min(layout, n) }, (_, i) => String(i + 1));
      expect(Object.values(paneSlots(container)).sort()).toEqual(expected);
    },
  );

  it('a numeração acompanha o swap quando uma aba oculta é promovida', () => {
    const { container } = renderGrid(3, 2);
    // Ativa o painel da ESQUERDA (slot 0) e promove a aba oculta para ele.
    const leftCell = visibleTiles(container).find((c) => c.style.order === '0') as HTMLElement;
    fireEvent.mouseDown(leftCell);
    const allTabs = within(container.querySelector('[role="tablist"]') as HTMLElement).getAllByRole('tab');
    fireEvent.click(allTabs.find((t) => !t.className.includes('grid-tab--current')) as HTMLElement);

    // p1:3 entrou no slot 0 — sua aba tem de dizer "1", e p1:2 seguir em "2".
    expect(paneSlots(container)).toEqual({ 'p1:3': '1', 'p1:2': '2' });
    expectTabsMatchPanes(container);
  });

  it('a aba do painel ATIVO é distinguível das demais visíveis', () => {
    const { container } = renderGrid(3, 2);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    const activeTabs = within(tablist)
      .getAllByRole('tab')
      .filter((t) => t.className.includes('grid-tab--active-pane'));
    expect(activeTabs).toHaveLength(1);

    // E é a aba do painel que o grid marcou como ativo (default: último slot).
    const activeCell = container.querySelector('.terminal-grid-cell--active') as HTMLElement;
    const activeChannel = activeCell.querySelector('.terminal-tile')?.getAttribute('data-channel-id');
    expect(activeTabs[0]?.textContent).toContain(sessionOf(activeChannel as string));
  });

  it('layout de painel único não numera nada (ruído sem ambiguidade)', () => {
    const { container } = renderGrid(3, 1);
    expect(container.querySelectorAll('.terminal-grid-slot')).toHaveLength(0);
    expect(container.querySelectorAll('.grid-tab-slot')).toHaveLength(0);
    expect(container.querySelectorAll('.grid-tab--active-pane')).toHaveLength(0);
  });

  it('o badge do painel não intercepta clique do xterm (pointer-events)', () => {
    // Regressão: um badge clicável sobre o terminal roubaria seleção de texto e
    // o mousedown que ativa o painel. A garantia é do CSS, então o teste trava
    // a marcação que o CSS depende (aria-hidden + classe estável).
    const { container } = renderGrid(2, 2);
    const badge = container.querySelector('.terminal-grid-slot') as HTMLElement;
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.tagName).toBe('SPAN');
  });
});

// Sanity: TerminalTile is imported/used by the grid (module graph coherence).
it('TerminalTile is a function component', () => {
  expect(typeof TerminalTile).toBe('function');
});
