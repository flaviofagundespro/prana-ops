/**
 * TerminalTile tests.
 *
 * Story 1.4 (AC2/AC3/AC4): input routing, resize emission, batched output filtered
 * by channelId.
 * Story 1.5 (AC1/AC2/AC3/AC4): history request on mount, the history→live-stream
 * SEQUENCING gate (live data queued until history lands, then history first, then
 * the drained live stream — never interleaved), history:error/timeout draining,
 * and the per-tile "reconnecting" indicator driven by channel:state.
 *
 * Uses a fake terminal (no jsdom canvas) and a fake WsClient; the batching path AND
 * the history timeout are driven by an injected fake scheduler so
 * `vi.useFakeTimers()` controls timing deterministically (never real time).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { TerminalTile, type TileTerminal, type CreateTerminal } from './TerminalTile.js';
import type { WsClient, WsMessageListener } from '../lib/ws-client.js';
import type { ClientToServerMessage, ServerToClientMessage } from '../ws-protocol.js';
import type { BatchScheduler } from '../lib/output-batcher.js';

/** Fake terminal capturing writes and exposing the input handler. */
function makeFakeTerminal(dims: { cols: number; rows: number } = { cols: 80, rows: 24 }): TileTerminal & {
  writes: string[];
  emitInput: (data: string) => void;
} {
  const writes: string[] = [];
  let inputHandler: ((data: string) => void) | null = null;
  return {
    writes,
    emitInput: (data: string) => inputHandler?.(data),
    onData(handler) {
      inputHandler = handler;
      return { dispose: () => (inputHandler = null) };
    },
    write(data) {
      writes.push(data);
    },
    open() {},
    dispose() {},
    fit() {
      return dims;
    },
  };
}

/** Fake WsClient recording sends and letting the test push server messages. */
function makeFakeWs(): WsClient & {
  sent: ClientToServerMessage[];
  push: (message: ServerToClientMessage) => void;
} {
  const sent: ClientToServerMessage[] = [];
  const listeners = new Set<WsMessageListener>();
  return {
    sent,
    push: (message) => listeners.forEach((l) => l(message)),
    send: (message) => sent.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Fake scheduler bridging OutputBatcher + history timeout to vitest fake timers. */
const fakeScheduler: BatchScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Renders a tile with the Story 1.5 props wired to the fakes. */
function renderTile(
  channelId: string,
  ws: WsClient,
  term: TileTerminal,
  opts: { profileId?: string; sessionName?: string; batchMs?: number; historyTimeoutMs?: number } = {},
) {
  const createTerminal: CreateTerminal = () => term;
  return render(
    <TerminalTile
      channelId={channelId}
      ws={ws}
      profileId={opts.profileId ?? '1'}
      sessionName={opts.sessionName ?? 'ckpt-a-claude-1'}
      createTerminal={createTerminal}
      scheduler={fakeScheduler}
      batchMs={opts.batchMs ?? 16}
      historyTimeoutMs={opts.historyTimeoutMs ?? 5000}
    />,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TerminalTile input/resize (Story 1.4)', () => {
  it('sends channel:data with THIS channelId on user input (AC2)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:1', ws, term);

    term.emitInput('ls\n');

    expect(ws.sent).toContainEqual({ type: 'channel:data', channelId: 'p1:1', data: 'ls\n' });
  });

  it('emits channel:resize with fit dimensions on mount (AC3)', () => {
    const term = makeFakeTerminal({ cols: 120, rows: 40 });
    const ws = makeFakeWs();
    renderTile('p1:2', ws, term);

    expect(ws.sent).toContainEqual({ type: 'channel:resize', channelId: 'p1:2', cols: 120, rows: 40 });
  });

  it('ignores channel:data for a DIFFERENT channelId (AC2 routing)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:4', ws, term);
    // Open the history gate so live data would be written if it were ours.
    ws.push({ type: 'history:result', channelId: 'p1:4', data: '' });

    ws.push({ type: 'channel:data', channelId: 'someone-else', data: 'not mine' });
    vi.advanceTimersByTime(16);

    expect(term.writes).toEqual([]);
  });
});

describe('TerminalTile history request (Story 1.5, AC1)', () => {
  it('sends history:request on mount with profileId/channelId/sessionName', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:9', ws, term, { profileId: '7', sessionName: 'ckpt-proj-claude-2' });

    expect(ws.sent).toContainEqual({
      type: 'history:request',
      profileId: '7',
      channelId: 'p1:9',
      sessionName: 'ckpt-proj-claude-2',
    });
  });
});

describe('TerminalTile history→live sequencing gate (Story 1.5, AC1, AC4)', () => {
  it('does NOT write live channel:data before history:result arrives (queued, not interleaved)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term);

    // Live stream arrives BEFORE history — must be queued, never written yet.
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'live1' });
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'live2' });
    vi.advanceTimersByTime(16); // even after a batch window, nothing is written

    expect(term.writes).toEqual([]);
  });

  it('writes history FIRST (single write), THEN drains the queued live stream in order (AC1)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term);

    // Live chunks arrive while history is pending → queued.
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'L1' });
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'L2' });
    expect(term.writes).toEqual([]);

    // History arrives: written immediately (one direct write, bypassing batcher).
    ws.push({ type: 'history:result', channelId: 'p1:3', data: 'HISTORY\n' });
    expect(term.writes).toEqual(['HISTORY\n']);

    // Then the queued live stream drains through the batcher (one coalesced flush).
    vi.advanceTimersByTime(16);
    expect(term.writes).toEqual(['HISTORY\n', 'L1L2']);
  });

  it('after the gate opens, subsequent live data flows normally through the batcher', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term);

    ws.push({ type: 'history:result', channelId: 'p1:3', data: 'H\n' });
    expect(term.writes).toEqual(['H\n']);

    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'x' });
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'y' });
    vi.advanceTimersByTime(16);
    expect(term.writes).toEqual(['H\n', 'xy']);
  });

  it('history:error drains the queued live stream anyway (never blocks the tile) (AC4)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term);

    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'Q1' });
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'Q2' });
    expect(term.writes).toEqual([]);

    ws.push({ type: 'history:error', channelId: 'p1:3', message: 'dead session' });
    vi.advanceTimersByTime(16);

    // No history written, but the live stream drained in order.
    expect(term.writes).toEqual(['Q1Q2']);
  });

  it('history timeout drains the queued live stream if no reply ever arrives (AC4)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term, { historyTimeoutMs: 5000 });

    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'T1' });
    expect(term.writes).toEqual([]);

    // Fire the history timeout: gate opens, queue drains — never hangs.
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(16); // batch window for the drained chunk
    expect(term.writes).toEqual(['T1']);
  });

  it('ignores history:result for a DIFFERENT channelId', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term);

    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'mine' });
    // History for another tile must not open THIS tile's gate.
    ws.push({ type: 'history:result', channelId: 'other', data: 'NOT MINE' });
    vi.advanceTimersByTime(16);

    expect(term.writes).toEqual([]); // still gated
  });
});

describe('TerminalTile reconnecting state (Story 1.5, AC3)', () => {
  it('shows the reconnecting indicator on channel:state reconnecting for its profileId', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term, { profileId: '1' });

    expect(screen.queryByTestId('reconnecting-indicator')).toBeNull();
    act(() => ws.push({ type: 'channel:state', profileId: '1', state: 'reconnecting' }));
    expect(screen.getByTestId('reconnecting-indicator')).not.toBeNull();
  });

  it('removes the indicator and re-requests history on reconnecting → connected (AC3, AC4)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term, { profileId: '1' });

    // Open the initial gate so we start from a clean live-stream state.
    ws.push({ type: 'history:result', channelId: 'p1:3', data: 'H0\n' });
    const sentBefore = ws.sent.filter((m) => m.type === 'history:request').length;

    act(() => ws.push({ type: 'channel:state', profileId: '1', state: 'reconnecting' }));
    expect(screen.getByTestId('reconnecting-indicator')).not.toBeNull();

    act(() => ws.push({ type: 'channel:state', profileId: '1', state: 'connected' }));
    // Indicator gone.
    expect(screen.queryByTestId('reconnecting-indicator')).toBeNull();
    // A fresh history:request was fired for the reconnected channel (AC4).
    const sentAfter = ws.sent.filter((m) => m.type === 'history:request').length;
    expect(sentAfter).toBe(sentBefore + 1);
  });

  it('re-gates the live stream after reconnect: history replays before live resumes (AC4)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term, { profileId: '1' });

    // Initial mount gate opens.
    ws.push({ type: 'history:result', channelId: 'p1:3', data: 'H0\n' });
    expect(term.writes).toEqual(['H0\n']);

    // Drop + reconnect.
    act(() => ws.push({ type: 'channel:state', profileId: '1', state: 'reconnecting' }));
    act(() => ws.push({ type: 'channel:state', profileId: '1', state: 'connected' }));

    // Live data arriving now (post-reconnect, pre-replay) must be queued again.
    ws.push({ type: 'channel:data', channelId: 'p1:3', data: 'POST' });
    vi.advanceTimersByTime(16);
    expect(term.writes).toEqual(['H0\n']); // still gated — POST not written

    // Replay lands, then the queued live stream drains.
    ws.push({ type: 'history:result', channelId: 'p1:3', data: 'H1\n' });
    expect(term.writes).toEqual(['H0\n', 'H1\n']);
    vi.advanceTimersByTime(16);
    expect(term.writes).toEqual(['H0\n', 'H1\n', 'POST']);
  });

  it('ignores channel:state for a DIFFERENT profileId (does not activate indicator) (AC3)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:3', ws, term, { profileId: '1' });

    act(() => ws.push({ type: 'channel:state', profileId: '2', state: 'reconnecting' }));
    expect(screen.queryByTestId('reconnecting-indicator')).toBeNull();
  });
});

describe('TerminalTile — falha de canal visível (Story 2.15/AC2)', () => {
  it('escreve a mensagem de erro do canal no terminal', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:4', ws, term, { profileId: '1' });
    // Abre o gate de histórico para não confundir com enfileiramento.
    ws.push({ type: 'history:result', channelId: 'p1:4', data: '' });

    act(() =>
      ws.push({
        type: 'channel:error',
        profileId: '1',
        channelId: 'p1:4',
        message:
          'o servidor recusou um canal novo nesta conexão SSH (limite de ~10 canais por conexão — MaxSessions do sshd). Abrindo uma conexão adicional para este perfil; a sessão deve subir em alguns segundos.',
      }),
    );

    const escrito = term.writes.join('');
    // A sessão que não abre passa a DIZER por quê — era isso que faltava.
    expect(escrito).toContain('[cockpit]');
    expect(escrito).toContain('MaxSessions');
    expect(escrito).toContain('conexão adicional');
    // Peso, não cor: a paleta pertence aos estados do watcher.
    expect(escrito).toContain('\x1b[1m');
    // ESC montado por código: um literal de controle dentro do regex dispara
    // `no-control-regex` e reprovava o gate de lint do repo inteiro.
    const ESC = String.fromCharCode(27);
    expect(escrito).not.toMatch(new RegExp(`${ESC}\\[3[0-7]m`));
  });

  it('ignora erro de OUTRO canal (mesmo roteamento do channel:data)', () => {
    const term = makeFakeTerminal();
    const ws = makeFakeWs();
    renderTile('p1:4', ws, term, { profileId: '1' });
    ws.push({ type: 'history:result', channelId: 'p1:4', data: '' });
    const antes = term.writes.length;

    act(() =>
      ws.push({ type: 'channel:error', profileId: '1', channelId: 'p1:9', message: 'erro alheio' }),
    );

    expect(term.writes).toHaveLength(antes);
  });
});
