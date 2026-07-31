import { TerminalTile, type CreateTerminal } from './TerminalTile.js';
import type { WsClient } from '../lib/ws-client.js';
import type { BatchScheduler } from '../lib/output-batcher.js';

/**
 * Grid de terminais (AC1, AC5) — APENAS os painéis. Os controles (layouts
 * 1/2/4/6 e abas) subiram para o header como {@link GridControls}, e o estado
 * de slots vive no hook `useGridSlots` (compartilhado via App) — feedback do
 * uso diário, 2026-07-15: as barras acima do grid custavam altura de terminal.
 *
 * TRADE-OFF (documented, @dev decision per Task 5): ALL tiles stay MOUNTED at
 * all times — overflow tiles are hidden with `display:none`, never unmounted.
 * This keeps every terminal's ws subscription and scrollback alive when
 * switching tabs. Slot position is applied via CSS `order` (cells never move
 * in the DOM, so the live xterm instances are untouched by swaps).
 *
 * Each rendered tile maps to EXACTLY ONE channelId (AC5) — the grid never
 * shares a channel between tiles and never opens a channel itself.
 */

export type GridLayout = 1 | 2 | 4 | 6;

export interface GridTile {
  channelId: string;
  sessionName: string;
  profileId: string;
  /**
   * Rótulo da ABA: "vps2letras-projeto-tema-n" (ex.: "az-prana-auto-1") —
   * abas misturam VPS, então precisam do contexto completo; o CLI fica de
   * fora (decisão de produto 2026-07-15). Fallback: sessionName.
   */
  tabLabel?: string;
}

export interface TerminalGridProps {
  tiles: GridTile[];
  layout: GridLayout;
  ws: WsClient;
  /** channelIds visíveis em ordem de slot (do useGridSlots, via App). */
  visibleIds: string[];
  /** Índice (nos visíveis) do painel ativo — destacado e alvo das abas. */
  activeIndex: number;
  /** Clique em qualquer ponto de um painel o torna o ativo. */
  onActivateSlot: (slotIndex: number) => void;
  /** Injectable for tests (forwarded to each tile). */
  createTerminal?: CreateTerminal;
  scheduler?: BatchScheduler;
  batchMs?: number;
}

/** CSS column count per layout (rows follow from grid auto-flow). */
const COLUMNS: Record<GridLayout, number> = { 1: 1, 2: 2, 4: 2, 6: 3 };

export function TerminalGrid({
  tiles,
  layout,
  ws,
  visibleIds,
  activeIndex,
  onActivateSlot,
  createTerminal,
  scheduler,
  batchMs,
}: TerminalGridProps): JSX.Element {
  const visibleChannelIds = new Set(visibleIds);
  const visibleCount = visibleIds.length;

  return (
    <div className="terminal-grid-wrapper">
      <div
        className="terminal-grid"
        data-layout={layout}
        style={{ display: 'grid', gridTemplateColumns: `repeat(${COLUMNS[layout]}, 1fr)` }}
      >
        {/* ALL tiles stay mounted; non-visible ones are hidden (display:none).
            Slot position comes from CSS `order` (never a DOM move). Mousedown em
            QUALQUER ponto do painel (inclusive dentro do xterm, via capture) o
            torna o painel ativo; destaque só faz sentido com 2+ painéis. */}
        {tiles.map((t) => {
          const visible = visibleChannelIds.has(t.channelId);
          const slotIndex = visibleIds.indexOf(t.channelId);
          const isActive = visible && visibleCount > 1 && slotIndex === activeIndex;
          return (
            <div
              key={t.channelId}
              className={isActive ? 'terminal-grid-cell terminal-grid-cell--active' : 'terminal-grid-cell'}
              data-visible={visible}
              data-active-pane={isActive || undefined}
              style={visible ? { order: slotIndex } : { display: 'none' }}
              onMouseDownCapture={visible ? () => onActivateSlot(slotIndex) : undefined}
            >
              {/* Mapa aba→painel (2026-07-27): o número do slot, igual ao da aba
                  correspondente no header. `pointer-events: none` no CSS — o
                  badge não pode roubar clique/seleção do xterm embaixo dele. */}
              {visible && visibleCount > 1 && (
                <span
                  className={isActive ? 'terminal-grid-slot terminal-grid-slot--active' : 'terminal-grid-slot'}
                  aria-hidden="true"
                >
                  {slotIndex + 1}
                </span>
              )}
              <TerminalTile
                channelId={t.channelId}
                ws={ws}
                profileId={t.profileId}
                sessionName={t.sessionName}
                {...(createTerminal ? { createTerminal } : {})}
                {...(scheduler ? { scheduler } : {})}
                {...(batchMs !== undefined ? { batchMs } : {})}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
