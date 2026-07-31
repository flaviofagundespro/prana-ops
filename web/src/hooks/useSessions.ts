import { useCallback, useRef, useState } from 'react';
import type { GridTile } from '../components/TerminalGrid.js';
import type { SessionCreatedAck } from '../ws-protocol.js';

/**
 * Owns the list of active grid tiles (Story 1.4, Task 7). A tile is keyed by the
 * server-minted `channelId` (stable across reconnect). Adding the same channelId
 * twice is idempotent (reopening a session the server attaches to returns the
 * same channelId, so no duplicate tile appears).
 *
 * Tile identity is the (profileId, sessionName) PAIR — tmux names are namespaced
 * PER HOST, so the same `ckpt-*` name may legitimately exist on two VPS at once
 * (cross-VPS collision found in field use, 2026-07-14). Deduping by sessionName
 * alone silently swallowed the second VPS's tile.
 */
export function useSessions(): {
  tiles: GridTile[];
  addTileFromAck: (ack: SessionCreatedAck, tabLabel?: string) => boolean;
  removeTile: (profileId: string, sessionName: string) => void;
} {
  const [tiles, setTiles] = useState<GridTile[]>([]);
  // Mirror of `tiles` readable SYNCHRONOUSLY inside addTileFromAck: the caller
  // needs the added/duplicate verdict at call time (to close the orphan channel
  // of a dropped ack), and a setState updater only runs later in the render.
  const tilesRef = useRef<GridTile[]>([]);

  // Story 1.7: ao deletar uma sessão (tmux morto na VPS), o tile aberto dela
  // sai do grid — mantê-lo seria um canal para uma sessão que não existe mais.
  // Escopado por perfil: o MESMO nome pode estar aberto em outra VPS.
  const removeTile = useCallback((profileId: string, sessionName: string): void => {
    tilesRef.current = tilesRef.current.filter(
      (t) => !(t.profileId === profileId && t.sessionName === sessionName),
    );
    setTiles(tilesRef.current);
  }, []);

  /**
   * Adds a tile for a `session:created` ack. Returns `false` when the ack was
   * DROPPED as a duplicate — the caller must then `channel:close` the ack's
   * channelId, otherwise the server-side channel leaks (each leaked channel
   * holds a tmux attach and counts against sshd MaxSessions — the exhaustion
   * behind SMK-002's "no channel opens anymore" seen again in field use).
   */
  const addTileFromAck = useCallback((ack: SessionCreatedAck, tabLabel?: string): boolean => {
    const prev = tilesRef.current;
    if (prev.some((t) => t.channelId === ack.channelId)) return false;
    // SMK-007: o servidor cunha um channelId NOVO a cada session:create, então
    // deduplicar só por channelId não evita dois tiles da mesma sessão tmux —
    // dedupe também por (profileId, sessionName); o tile existente permanece o dono.
    if (prev.some((t) => t.profileId === ack.profileId && t.sessionName === ack.sessionName)) {
      return false;
    }
    tilesRef.current = [
      ...prev,
      {
        channelId: ack.channelId,
        sessionName: ack.sessionName,
        profileId: ack.profileId,
        ...(tabLabel ? { tabLabel } : {}),
      },
    ];
    setTiles(tilesRef.current);
    return true;
  }, []);

  return { tiles, addTileFromAck, removeTile };
}
