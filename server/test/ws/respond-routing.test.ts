/**
 * ws respond routing tests (Story 2.7, AC1/AC4/AC8-aditividade): fake
 * RespondHandler — valida parse (id inteiro, texto com teto, token opcional),
 * tradução challenge/result para o socket e ausência do responder (aditivo).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachWebSocketServer, type RespondHandler } from '../../src/ws/index.js';
import type { RespondOutcome } from '../../src/watcher/responder.js';

let server: http.Server | undefined;

function start(responder?: RespondHandler): Promise<number> {
  const s = http.createServer();
  attachWebSocketServer({
    server: s,
    path: '/ws',
    ...(responder ? { decisionResponder: responder } : {}),
  });
  server = s;
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('ws decisions:respond routing (Story 2.7)', () => {
  it('roteia para o responder e devolve challenge (high) com comando exato + token', async () => {
    const respond = vi.fn(async (): Promise<RespondOutcome> => ({
      kind: 'challenge',
      command: `tmux send-keys -l -t 'ckpt-a' -- 'y' && ...`,
      confirmToken: 'tok-1',
    }));
    const port = await start({ respond });
    const ws = await connect(port);

    ws.send(JSON.stringify({
      type: 'decisions:respond', profileId: '3', decisionId: 7,
      sessionName: 'ckpt-a-claude-1', text: 'y',
    }));
    const challenge = await nextMessage(ws, 'decisions:respond:challenge');

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 7, text: 'y' }));
    expect(challenge.command).toContain('send-keys');
    expect(challenge.confirmToken).toBe('tok-1');
    ws.close();
  });

  it('devolve result ok e repassa o confirmToken ao responder', async () => {
    const respond = vi.fn(async (): Promise<RespondOutcome> => ({ kind: 'result', ok: true }));
    const port = await start({ respond });
    const ws = await connect(port);

    ws.send(JSON.stringify({
      type: 'decisions:respond', profileId: '3', decisionId: 7,
      sessionName: 'ckpt-a-claude-1', text: 'y', confirmToken: 'tok-9',
    }));
    const result = await nextMessage(ws, 'decisions:respond:result');

    expect(result.ok).toBe(true);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ confirmToken: 'tok-9' }));
    ws.close();
  });

  it('parse rejeita malformadas (id não-inteiro, texto vazio, texto acima do teto)', async () => {
    const respond = vi.fn(async (): Promise<RespondOutcome> => ({ kind: 'result', ok: true }));
    const port = await start({ respond });
    const ws = await connect(port);

    const bad = [
      { type: 'decisions:respond', profileId: '3', decisionId: 1.5, sessionName: 'ckpt-a', text: 'y' },
      { type: 'decisions:respond', profileId: '3', decisionId: 7, sessionName: 'ckpt-a', text: '' },
      { type: 'decisions:respond', profileId: '3', decisionId: 7, sessionName: 'ckpt-a', text: 'x'.repeat(2001) },
    ];
    for (const msg of bad) {
      ws.send(JSON.stringify(msg));
      const err = await nextMessage(ws, 'error');
      expect(String(err.message)).toContain('unknown or malformed');
    }
    expect(respond).not.toHaveBeenCalled();
    ws.close();
  });

  it('sem responder configurado → result ok:false (aditivo, sem crash)', async () => {
    const port = await start();
    const ws = await connect(port);

    ws.send(JSON.stringify({
      type: 'decisions:respond', profileId: '3', decisionId: 7,
      sessionName: 'ckpt-a-claude-1', text: 'y',
    }));
    const result = await nextMessage(ws, 'decisions:respond:result');
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain('unavailable');
    ws.close();
  });
});
