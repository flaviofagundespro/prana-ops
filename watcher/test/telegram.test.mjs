/**
 * Testes da notificação Telegram (Story 2.5, AC9): watcher real em memória +
 * Telegram MOCKADA via `fetchImpl`/`sleepImpl` injetáveis (nenhuma chamada de
 * rede real, nenhuma espera de 30s de verdade). Cobrem: mensagem com
 * sessão+summary+risco; env ausente (desligado); falha de rede não derruba
 * nem bloqueia; `notified_at` previne re-envio; retry respeita limite e
 * 429/retry_after; sessão não-ckpt nunca chega ao notificador.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createWatcher } from '../watcher.mjs';
import { createNotifier, formatMessage } from '../telegram.mjs';

function telegramOk() {
  return { ok: true, json: async () => ({ ok: true, result: {} }) };
}

function telegram429(retryAfterSeconds) {
  return {
    ok: false,
    status: 429,
    json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: retryAfterSeconds } }),
  };
}

describe('formatMessage (AC1)', () => {
  it('contém sessão, summary e risco em texto simples', () => {
    const text = formatMessage({
      sessionName: 'ckpt-prana-claude-1',
      summary: 'Aprovar deploy?',
      risk: 'high',
      createdAt: '2026-07-16 12:00:00',
    });
    expect(text).toContain('ckpt-prana-claude-1');
    expect(text).toContain('Aprovar deploy?');
    expect(text).toContain('ALTO');
    expect(text).toContain('2026-07-16 12:00:00');
  });
});

describe('notificador integrado (watcher real em memória + Telegram mockada)', () => {
  let watcher;

  beforeEach(() => {
    watcher = createWatcher({ dbPath: ':memory:' });
  });

  function baseConfig(overrides = {}) {
    return { botToken: 'fake-token', chatId: '12345', retryDelayMs: 5, ...overrides };
  }

  const noSleep = () => Promise.resolve();

  it('AC1: envia mensagem e marca notified_at', async () => {
    let sentBody;
    const fetchImpl = async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return telegramOk();
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });

    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-1', source: 'regex', summary: 'Aprovar?', risk: 'high' });
    await notifier.maybeNotify({ sessionName: 'ckpt-tg-1', decisionId });

    expect(sentBody.chat_id).toBe('12345');
    expect(sentBody.text).toContain('ckpt-tg-1');
    expect(sentBody.text).toContain('Aprovar?');

    const decision = watcher.getDecision(decisionId);
    expect(decision.notified_at).toBeTruthy();

    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'telegram'`).all();
    expect(JSON.parse(events[0].payload).outcome).toBe('success');
  });

  it('AC2: sem env completo, desligado silenciosamente (no-op, sem chamada)', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return telegramOk();
    };
    const notifier = createNotifier({
      watcher,
      config: { botToken: undefined, chatId: '12345' },
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(notifier.isEnabled()).toBe(false);

    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-2', source: 'regex', summary: 'x', risk: 'high' });
    await notifier.maybeNotify({ sessionName: 'ckpt-tg-2', decisionId });

    expect(called).toBe(false);
    expect(watcher.getDecision(decisionId).notified_at).toBeNull();
  });

  it('AC3/AC8: falha de rede não lança e não bloqueia — decisão permanece na fila', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-3', source: 'regex', summary: 'x', risk: 'high' });

    await expect(notifier.maybeNotify({ sessionName: 'ckpt-tg-3', decisionId })).resolves.toBeUndefined();

    const decision = watcher.getDecision(decisionId);
    expect(decision.status).toBe('pending'); // continua na fila
    expect(decision.notified_at).toBeNull();
    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'telegram'`).all();
    expect(JSON.parse(events[0].payload).outcome).toBe('error');
  });

  it('AC5: retry respeita o limite de 2 tentativas adicionais (3 chamadas no total)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-4', source: 'regex', summary: 'x', risk: 'high' });

    await notifier.maybeNotify({ sessionName: 'ckpt-tg-4', decisionId });
    expect(calls).toBe(3);
  });

  it('AC5: sucesso numa retentativa não continua tentando', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 500, json: async () => ({}) };
      return telegramOk();
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-5', source: 'regex', summary: 'x', risk: 'high' });

    await notifier.maybeNotify({ sessionName: 'ckpt-tg-5', decisionId });
    expect(calls).toBe(2);
    expect(watcher.getDecision(decisionId).notified_at).toBeTruthy();
  });

  it('AC5: respeita retry_after do 429 quando maior que o delay configurado', async () => {
    const sleeps = [];
    const sleepImpl = async (ms) => {
      sleeps.push(ms);
    };
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return telegram429(1); // 1s = 1000ms > retryDelayMs (5ms)
      return telegramOk();
    };
    const notifier = createNotifier({ watcher, config: baseConfig({ retryDelayMs: 5 }), fetchImpl, sleepImpl });
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-6', source: 'regex', summary: 'x', risk: 'high' });

    await notifier.maybeNotify({ sessionName: 'ckpt-tg-6', decisionId });
    expect(sleeps[0]).toBe(1000);
  });

  it('AC4: notified_at previne re-notificação (não reenvia decisão já notificada)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return telegramOk();
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-7', source: 'regex', summary: 'x', risk: 'high' });

    await notifier.maybeNotify({ sessionName: 'ckpt-tg-7', decisionId });
    await notifier.maybeNotify({ sessionName: 'ckpt-tg-7', decisionId }); // já notificada
    expect(calls).toBe(1);
  });

  it('AC4: sweepUnnotified recupera decisão criada sem watcher.setNotifier (crash simulado)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return telegramOk();
    };
    // Decisão criada SEM notifier plugado (equivalente a um restart do watcher
    // entre a criação e o envio — a notificação imediata nunca disparou).
    const decisionId = watcher.ingestCandidate({ sessionName: 'ckpt-tg-8', source: 'regex', summary: 'x', risk: 'high' });
    expect(watcher.getDecision(decisionId).notified_at).toBeNull();

    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    await notifier.sweepUnnotified();

    expect(calls).toBe(1);
    expect(watcher.getDecision(decisionId).notified_at).toBeTruthy();
  });

  it('AC10 (allowlist a montante): sessão não-ckpt nunca gera decisão, logo nunca chega ao notificador', () => {
    const decisionId = watcher.ingestCandidate({ sessionName: '4terminal', source: 'regex', summary: 'x', risk: 'high' });
    expect(decisionId).toBeNull();
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c).toBe(0);
  });

  it('ingestCandidate dispara o notifier SÓ em candidato genuinamente novo (não em touch)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return telegramOk();
    };
    const notifier = createNotifier({ watcher, config: baseConfig(), fetchImpl, sleepImpl: noSleep });
    watcher.setNotifier(notifier);

    watcher.ingestCandidate({ sessionName: 'ckpt-tg-9', source: 'regex', summary: 'primeira', risk: 'high' });
    await new Promise((r) => setImmediate(r));
    watcher.ingestCandidate({ sessionName: 'ckpt-tg-9', source: 'regex', summary: 'segunda (touch)', risk: 'high' });
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(1);
  });
});
