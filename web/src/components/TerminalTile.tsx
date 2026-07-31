import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { WsClient } from '../lib/ws-client.js';
import { OutputBatcher, type BatchScheduler } from '../lib/output-batcher.js';

/**
 * A single terminal tile bound to ONE server-minted `channelId` (AC2, AC3, AC4).
 *
 * Evolves the Story 1.1 `Terminal.tsx` placeholder by wiring the real ws
 * transport (which the placeholder lacked):
 *  - user input (`onData`) → `channel:data { channelId, data }` (AC2);
 *  - incoming `channel:data` filtered by THIS tile's `channelId` → xterm, via an
 *    {@link OutputBatcher} so bursty output flushes at most once per ~16ms (AC4);
 *  - the fit addon computes cols/rows on mount + resize and emits
 *    `channel:resize { channelId, cols, rows }` (AC3 — client end of
 *    fit → resize → window-change → tmux; the server end exists since 1.2).
 *
 * STORY 1.5 — HISTORY REPLAY + RECONNECTING STATE:
 *  On mount (and on each `reconnecting → connected` transition for this tile's
 *  `profileId`), the tile requests its tmux scrollback via `history:request` and
 *  GATES the live stream until it arrives:
 *   1. any `channel:data` that arrives while history is pending is ENQUEUED to a
 *      local buffer (NOT written), so it can never interleave with the replay;
 *   2. on `history:result`, the history is written ONCE (`term.write`, bypassing
 *      the batcher — it is a single block, not a burst), THEN the buffered live
 *      chunks are drained through the batcher in arrival order (AC1, AC2, AC4);
 *   3. on `history:error` (or a client-side timeout), the buffer is drained anyway
 *      so the tile never hangs indefinitely (AC4).
 *  While the profile is `reconnecting`, a non-destructive overlay indicator is
 *  shown WITHOUT unmounting the tile (preserves the 1.4 `display:none` trade-off).
 *
 * The component never opens its own ws — it consumes the ONE shared {@link WsClient}
 * passed in (coherent with "1 connection per profile", avoids amplifying ARCH-002).
 *
 * The xterm instance is created via an injectable factory so tests can drive the
 * component with a fake terminal (no jsdom canvas). Defaults to real xterm + fit.
 */

/** The minimal terminal surface this tile drives. */
export interface TileTerminal {
  onData(handler: (data: string) => void): { dispose(): void };
  write(data: string): void;
  open(container: HTMLElement): void;
  dispose(): void;
  /** Fit to the container; returns the resulting dimensions (or undefined). */
  fit(): { cols: number; rows: number } | undefined;
}

/** Factory that builds a {@link TileTerminal}. Injectable for tests. */
export type CreateTerminal = () => TileTerminal;

const createRealTerminal: CreateTerminal = () => {
  const term = new XTerm({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'monospace',
    theme: { background: '#1e1e1e' },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Clipboard (feedback do uso diário, 2026-07-14): copiar-ao-selecionar.
  // Ctrl+C num terminal é SIGINT (não cópia), então a seleção vai direto ao
  // clipboard do browser. Colar é o paste nativo do xterm.js (Ctrl+V).
  // Dica: se o app interno (tmux/claude) capturar o mouse, selecione com
  // Shift pressionado — o xterm.js suprime o report e permite a seleção.
  term.onSelectionChange(() => {
    const selection = term.getSelection();
    if (selection && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(selection).catch(() => {
        // Clipboard pode ser negado fora de contexto seguro — silencioso.
      });
    }
  });
  return {
    onData: (handler) => term.onData(handler),
    write: (data) => term.write(data),
    open: (container) => term.open(container),
    dispose: () => term.dispose(),
    fit: () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      return dims ? { cols: dims.cols, rows: dims.rows } : undefined;
    },
  };
};

/** Default client-side timeout for a history:request (ms) — mirrors the server's
 * best-effort 5s query timeout so the gate never outlives a stuck capture. */
export const DEFAULT_HISTORY_TIMEOUT_MS = 5_000;

export interface TerminalTileProps {
  channelId: string;
  ws: WsClient;
  /**
   * The profile this tile's channel belongs to (Story 1.5). Needed to (a) request
   * history for the right connection and (b) filter `channel:state` events — the
   * tile only reacts to its OWN profile's reconnecting/connected transitions.
   * `GridTile` already carries `profileId` (ratified extension @po 2026-07-13).
   */
  profileId: string;
  /** The tmux session name to capture scrollback from (Story 1.5). */
  sessionName: string;
  /** Batching window (ms). Default from OutputBatcher (~16ms). */
  batchMs?: number;
  /** History request timeout (ms). Default {@link DEFAULT_HISTORY_TIMEOUT_MS}. */
  historyTimeoutMs?: number;
  /** Injectable scheduler for the batcher AND the history timeout (fake timers in tests). */
  scheduler?: BatchScheduler;
  /** Injectable terminal factory (fake terminal in tests). */
  createTerminal?: CreateTerminal;
}

export function TerminalTile({
  channelId,
  ws,
  profileId,
  sessionName,
  batchMs,
  historyTimeoutMs,
  scheduler,
  createTerminal = createRealTerminal,
}: TerminalTileProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = createTerminal();
    term.open(container);

    // Timer surface: reuse the batcher's scheduler (a generic set/clear timer) for
    // the history timeout too — same injectable so fake timers drive both.
    const timerScheduler: BatchScheduler = scheduler ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const historyTimeout = historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;

    // Output: batch bursty channel:data into ~16ms flushes (AC4). The batcher is
    // ONLY fed once the history gate is open (or has failed/timed out).
    const batcher = new OutputBatcher({
      flush: (data) => term.write(data),
      ...(batchMs !== undefined ? { delayMs: batchMs } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
    });

    // --- History sequencing gate (Story 1.5, Task 4) -----------------------
    // While `historyPending` is true, live channel:data is queued (not written).
    // On history:result/history:error/timeout the queue is drained through the
    // batcher — history ALWAYS lands before any live chunk (AC1, AC4).
    let historyPending = false;
    let pendingBuffer: string[] = [];
    let timeoutHandle: unknown = null;

    const clearHistoryTimeout = (): void => {
      if (timeoutHandle !== null) {
        timerScheduler.clear(timeoutHandle);
        timeoutHandle = null;
      }
    };

    /** Drains the queued live chunks through the batcher, in arrival order. */
    const drainPending = (): void => {
      const queued = pendingBuffer;
      pendingBuffer = [];
      for (const chunk of queued) batcher.append(chunk);
    };

    /** Closes the gate: history (if any) is already written; drain the live queue. */
    const openGate = (): void => {
      if (!historyPending) return;
      historyPending = false;
      clearHistoryTimeout();
      drainPending();
    };

    /** Opens the gate and starts a fresh history request for this channel. */
    const requestHistory = (): void => {
      historyPending = true;
      pendingBuffer = [];
      clearHistoryTimeout();
      timeoutHandle = timerScheduler.set(() => {
        // Timeout: never hang — drain the live stream even without history (AC4).
        timeoutHandle = null;
        openGate();
      }, historyTimeout);
      ws.send({ type: 'history:request', profileId, channelId, sessionName });
    };

    // Input: forward keystrokes as channel:data (AC2).
    const inputSub = term.onData((data) => {
      ws.send({ type: 'channel:data', channelId, data });
    });

    // Resize: fit → channel:resize (AC3, client end).
    const sendResize = (): void => {
      // SMK-008 (smoke E2E): não medir enquanto o tile está oculto
      // (display:none → largura 0) — o fit produzia dimensões minúsculas que
      // eram propagadas ao tmux e o tile ficava ~2x2cm ao ser promovido.
      // O guard só se aplica onde há engine de layout real (browser); em jsdom
      // (testes) TUDO mede 0 e ResizeObserver não existe — lá o fit segue direto.
      const hasLayoutEngine = typeof ResizeObserver !== 'undefined';
      if (hasLayoutEngine && (container.offsetWidth === 0 || container.offsetHeight === 0)) return;
      const dims = term.fit();
      if (dims) {
        ws.send({ type: 'channel:resize', channelId, cols: dims.cols, rows: dims.rows });
      }
    };
    sendResize();
    window.addEventListener('resize', sendResize);

    // SMK-008: re-fit quando o PRÓPRIO tile muda de tamanho — cobre a promoção
    // aba → visível (0 → tamanho real) e trocas de layout 1/2/4/6, que não
    // disparam `window.resize`. Guarded: jsdom (testes) não tem ResizeObserver.
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => sendResize());
      resizeObserver.observe(container);
    }

    // Was the profile in a reconnecting state? Used to detect the
    // reconnecting → connected transition that re-triggers history replay (AC4).
    let wasReconnecting = false;

    const unsubscribe = ws.subscribe((message) => {
      switch (message.type) {
        case 'channel:data': {
          if (message.channelId !== channelId) return;
          if (historyPending) {
            // Gate closed: queue, do NOT write (prevents interleaving) (AC4).
            pendingBuffer.push(message.data);
          } else {
            batcher.append(message.data);
          }
          return;
        }
        case 'history:result': {
          if (message.channelId !== channelId) return;
          if (!historyPending) return; // stale/duplicate — ignore
          // Write the history block ONCE, directly (not through the batcher — it is
          // a single block, not a burst), THEN drain the queued live stream (AC1).
          if (message.data.length > 0) term.write(message.data);
          openGate();
          return;
        }
        case 'history:error': {
          if (message.channelId !== channelId) return;
          if (!historyPending) return;
          // No history available — drain the live stream anyway; never hang (AC4).
          openGate();
          return;
        }
        case 'channel:error': {
          // Story 2.15/AC2 — até aqui o servidor emitia `channel:error`, o
          // protocolo o transportava e NINGUÉM no front o tratava: uma sessão que
          // não abria não dizia por quê. Era a mesma classe de defeito que a Fase
          // 2 combate nos estados — ausência de sinal passando por normalidade.
          //
          // Escrito NO TERMINAL, que é onde o operador está olhando quando
          // clicou na sessão. Peso (negrito), não cor: a paleta pertence aos
          // estados do watcher e `waiting_for_input` tem de seguir sendo o
          // elemento mais saliente da tela.
          if (message.channelId !== channelId) return;
          term.write(`\r\n\x1b[1m[cockpit]\x1b[0m ${message.message}\r\n`);
          return;
        }
        case 'channel:state': {
          // Only react to OUR profile's state (AC3). The server already scopes by
          // socket/perfil (ARCH-002), but a socket may own channels on multiple
          // profiles — the tile filters for its own profileId here.
          if (message.profileId !== profileId) return;
          if (message.state === 'reconnecting') {
            setReconnecting(true);
            wasReconnecting = true;
          } else if (message.state === 'connected') {
            setReconnecting(false);
            if (wasReconnecting) {
              // Reconnected: same channelId reattached — re-replay history, then
              // resume the live stream in order (AC4).
              wasReconnecting = false;
              requestHistory();
            }
          }
          return;
        }
        default:
          return;
      }
    });

    // Initial history request on mount (AC1): gate the live stream from the start.
    requestHistory();

    return () => {
      window.removeEventListener('resize', sendResize);
      resizeObserver?.disconnect();
      unsubscribe();
      clearHistoryTimeout();
      inputSub.dispose();
      batcher.dispose();
      term.dispose();
    };
  }, [channelId, ws, profileId, sessionName, batchMs, historyTimeoutMs, scheduler, createTerminal]);

  return (
    <div className="terminal-tile" data-channel-id={channelId} ref={containerRef}>
      {reconnecting && (
        <div className="terminal-tile__reconnecting" role="status" data-testid="reconnecting-indicator">
          Reconectando…
        </div>
      )}
    </div>
  );
}
