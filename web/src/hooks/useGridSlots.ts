import { useState } from 'react';
import type { GridLayout, GridTile } from '../components/TerminalGrid.js';

/**
 * Estado de slots do grid, extraído do TerminalGrid quando a barra de layouts
 * e as abas subiram para o header (feedback do uso diário, 2026-07-15: as duas
 * barras acima do grid custavam altura de terminal). Header (GridControls) e
 * grid (TerminalGrid) compartilham este estado via App.
 *
 * Modelo (inalterado desde o painel ativo): `slotOrder` é a ordem de trabalho
 * dos channelIds nos slots; entradas de tiles fechados são filtradas e tiles
 * novos entram no fim. O slot ATIVO recebe a próxima troca de aba; default é o
 * último slot visível (comportamento pré-painel-ativo preservado).
 */
export function useGridSlots(
  tiles: GridTile[],
  layout: GridLayout,
): {
  /** channelIds visíveis, em ordem de slot (índice = posição no grid). */
  visibleIds: string[];
  /** Índice (nos visíveis) do painel ativo — alvo da próxima troca de aba. */
  activeIndex: number;
  /** Torna um slot o painel ativo (clique no painel). */
  activateSlot: (slotIndex: number) => void;
  /** Coloca o tile clicado (aba) no slot ativo, via swap. */
  promoteToActiveSlot: (channelId: string) => void;
} {
  const [slotOrder, setSlotOrder] = useState<string[]>([]);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);

  const visibleCount = Math.min(layout, tiles.length);
  const known = new Set(tiles.map((t) => t.channelId));
  const kept = slotOrder.filter((id) => known.has(id));
  const keptSet = new Set(kept);
  const effectiveOrder = [
    ...kept,
    ...tiles.filter((t) => !keptSet.has(t.channelId)).map((t) => t.channelId),
  ];

  const visibleIds = effectiveOrder.slice(0, visibleCount);
  const activeIndex =
    visibleCount === 0 ? 0 : Math.min(activeSlot ?? visibleCount - 1, visibleCount - 1);

  const promoteToActiveSlot = (channelId: string): void => {
    const next = [...effectiveOrder];
    const from = next.indexOf(channelId);
    if (from === -1 || from === activeIndex) return;
    next[from] = next[activeIndex];
    next[activeIndex] = channelId;
    setSlotOrder(next);
  };

  return { visibleIds, activeIndex, activateSlot: setActiveSlot, promoteToActiveSlot };
}
