/**
 * Testes da Camada 3 — classificador GPT 5.6 (Story 2.4, AC9): watcher real
 * em memória + Azure MOCKADA via `fetchImpl` injetável (nenhuma chamada de
 * rede real). Cobrem: shape válido/inválido, timeout, cap diário, env
 * ausente (desligado), precedência de session_state, e não-bloqueio do
 * daemon em falha total da Azure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWatcher } from '../watcher.mjs';
import { createClassifier, parseClassifierResponse, readTailLines } from '../classifier.mjs';

function azureOkResponse(body) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

describe('parseClassifierResponse (AC3)', () => {
  it('aceita shape válido', () => {
    const parsed = parseClassifierResponse(
      JSON.stringify({ state: 'waiting_for_input', summary: 'Aprovar deploy?', risk: 'high' }),
    );
    expect(parsed).toEqual({ state: 'waiting_for_input', summary: 'Aprovar deploy?', risk: 'high' });
  });

  it('rejeita JSON inválido', () => {
    expect(parseClassifierResponse('não é json{')).toBeNull();
  });

  it('rejeita state fora do domínio', () => {
    expect(parseClassifierResponse(JSON.stringify({ state: 'confuso', summary: 'x', risk: 'high' }))).toBeNull();
  });

  it('rejeita risk fora do domínio (medium não existe)', () => {
    expect(parseClassifierResponse(JSON.stringify({ state: 'idle', summary: 'x', risk: 'medium' }))).toBeNull();
  });

  it('rejeita summary vazio ou ausente', () => {
    expect(parseClassifierResponse(JSON.stringify({ state: 'idle', summary: '', risk: 'low' }))).toBeNull();
    expect(parseClassifierResponse(JSON.stringify({ state: 'idle', risk: 'low' }))).toBeNull();
  });

  it('trunca summary em ~200 chars', () => {
    const long = 'x'.repeat(300);
    const parsed = parseClassifierResponse(JSON.stringify({ state: 'idle', summary: long, risk: 'low' }));
    expect(parsed.summary).toHaveLength(200);
  });
});

describe('readTailLines (AC1)', () => {
  it('diretório/arquivo inexistente não lança — devolve []', () => {
    expect(readTailLines('/tmp/nao-existe-de-jeito-nenhum.log')).toEqual([]);
  });
});

describe('classificador integrado (watcher real em memória + Azure mockada)', () => {
  let watcher;
  let logsDir;

  beforeEach(() => {
    watcher = createWatcher({ dbPath: ':memory:' });
    logsDir = mkdtempSync(path.join(tmpdir(), 'ckpt-classifier-'));
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  function baseConfig(overrides = {}) {
    return {
      endpoint: 'https://fake.openai.azure.com',
      apiKey: 'fake-key',
      deployment: 'gpt-5.6',
      dailyCap: 200,
      timeoutMs: 1000,
      ...overrides,
    };
  }

  function createDecision(sessionName) {
    return watcher.ingestCandidate({ sessionName, source: 'regex', summary: 'placeholder bruto', risk: 'high' });
  }

  it('AC1/AC4: shape válido atualiza summary/risk/state da decisão existente', async () => {
    const fetchImpl = async () =>
      azureOkResponse({ state: 'waiting_for_input', summary: 'Aprovar migration da tabela X?', risk: 'low' });
    // NÃO chama watcher.setClassifier aqui: o disparo automático via
    // ingestCandidate é testado à parte (último teste do describe); este
    // teste chama maybeClassify diretamente para controle determinístico.
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });

    const decisionId = createDecision('ckpt-cls-1');
    await classifier.maybeClassify({ sessionName: 'ckpt-cls-1', decisionId });

    const decision = watcher.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    expect(decision.summary).toBe('Aprovar migration da tabela X?');
    expect(decision.risk).toBe('low');
    expect(decision.state).toBe('waiting_for_input');

    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'classifier'`).all();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ outcome: 'success', risk: 'low' });
  });

  it('AC3: shape inválido mantém a decisão como estava (continua high)', async () => {
    const fetchImpl = async () => azureOkResponse({ state: 'esquisito', summary: 'x', risk: 'low' });
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });

    const decisionId = createDecision('ckpt-cls-2');
    await classifier.maybeClassify({ sessionName: 'ckpt-cls-2', decisionId });

    const decision = watcher.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    expect(decision.summary).toBe('placeholder bruto');
    expect(decision.risk).toBe('high');

    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'classifier'`).all();
    expect(JSON.parse(events[0].payload).outcome).toBe('invalid_shape');
  });

  it('AC5/AC8: timeout mantém high e nunca lança (daemon não derruba)', async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig({ timeoutMs: 30 }), fetchImpl });

    const decisionId = createDecision('ckpt-cls-3');
    await expect(classifier.maybeClassify({ sessionName: 'ckpt-cls-3', decisionId })).resolves.toBeUndefined();

    const decision = watcher.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    expect(decision.risk).toBe('high');
    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'classifier'`).all();
    expect(JSON.parse(events[0].payload).outcome).toBe('error');
  });

  it('AC8: falha total da Azure (5xx) nunca lança e não bloqueia', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });
    const decisionId = createDecision('ckpt-cls-4');
    await expect(classifier.maybeClassify({ sessionName: 'ckpt-cls-4', decisionId })).resolves.toBeUndefined();
    expect(watcher.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId).risk).toBe('high');
  });

  it('AC5: cap diário bloqueia e registra evento sem chamar a Azure', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return azureOkResponse({ state: 'idle', summary: 'ok', risk: 'low' });
    };
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig({ dailyCap: 1 }), fetchImpl });

    const d1 = createDecision('ckpt-cls-5a');
    await classifier.maybeClassify({ sessionName: 'ckpt-cls-5a', decisionId: d1 });
    expect(calls).toBe(1);

    const d2 = createDecision('ckpt-cls-5b');
    await classifier.maybeClassify({ sessionName: 'ckpt-cls-5b', decisionId: d2 });
    expect(calls).toBe(1); // cap atingido — Azure NÃO foi chamada de novo

    const events = watcher.db.prepare(`SELECT * FROM events WHERE source = 'classifier'`).all();
    const skipEvent = events.map((e) => JSON.parse(e.payload)).find((p) => p.skipped === 'daily_cap');
    expect(skipEvent).toBeDefined();
    expect(skipEvent.sessionName).toBe('ckpt-cls-5b');
  });

  it('AC2: sem env completo, a camada fica desligada silenciosamente (no-op)', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return azureOkResponse({ state: 'idle', summary: 'x', risk: 'low' });
    };
    const classifier = createClassifier({
      watcher,
      logsDir,
      config: { endpoint: undefined, apiKey: 'k', deployment: 'd' }, // endpoint ausente
      fetchImpl,
    });
    expect(classifier.isEnabled()).toBe(false);

    const decisionId = createDecision('ckpt-cls-6');
    await classifier.maybeClassify({ sessionName: 'ckpt-cls-6', decisionId });
    expect(called).toBe(false);
    // Nenhum evento registrado: maybeClassify saiu antes de qualquer escrita
    // (ingestCandidate em si não grava events — só o handler HTTP /hook faz).
    expect(watcher.db.prepare('SELECT * FROM events').all()).toHaveLength(0);
  });

  it('AC4/AC7: precedência — hook chegado DURANTE a chamada em voo vence o classificador', async () => {
    const decisionId = createDecision('ckpt-cls-7');
    // O "hook" é simulado DENTRO do mock do fetch — ou seja, chega depois que
    // `requestStartedAt` já foi capturado (a chamada está em voo) e antes da
    // resposta do classificador ser aplicada. É exatamente o cenário do AC7.
    const fetchImpl = async () => {
      // Delay real: garante que o timestamp do "hook" caia em milissegundo
      // estritamente posterior ao de `requestStartedAt` (tudo mais neste
      // teste roda síncrono no mesmo tick — sem isso os dois podem colidir
      // no mesmo milissegundo e o guard de precedência não distingue).
      await new Promise((r) => setTimeout(r, 5));
      watcher.applyHeuristicState({
        sessionName: 'ckpt-cls-7',
        state: 'waiting_for_input',
        olderThan: watcher.now(),
      });
      return azureOkResponse({ state: 'idle', summary: 'sessão parece ociosa', risk: 'low' });
    };
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });

    await classifier.maybeClassify({ sessionName: 'ckpt-cls-7', decisionId });
    // A decisão em si (summary/risk) É atualizada pelo classificador...
    const decision = watcher.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    expect(decision.summary).toBe('sessão parece ociosa');
    // ...mas o session_state NÃO é rebaixado: o hook simulado é mais recente
    // que `requestStartedAt` (capturado ANTES da chamada à Azure começar).
    const state = watcher.db.prepare('SELECT * FROM session_state WHERE session_name = ?').get('ckpt-cls-7');
    expect(state.state).toBe('waiting_for_input');
  });

  it('AC5: no máximo 1 classificação em voo por sessão', async () => {
    let resolveFirst;
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Promise((resolve) => {
        resolveFirst = () => resolve(azureOkResponse({ state: 'idle', summary: 'ok', risk: 'low' }));
      });
    };
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });
    const decisionId = createDecision('ckpt-cls-8');

    const p1 = classifier.maybeClassify({ sessionName: 'ckpt-cls-8', decisionId });
    const p2 = classifier.maybeClassify({ sessionName: 'ckpt-cls-8', decisionId }); // deve ser no-op (já em voo)
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('ingestCandidate dispara o classificador SÓ em candidato genuinamente novo (não em touch)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return azureOkResponse({ state: 'waiting_for_input', summary: 'ok', risk: 'high' });
    };
    const classifier = createClassifier({ watcher, logsDir, config: baseConfig(), fetchImpl });
    watcher.setClassifier(classifier);

    watcher.ingestCandidate({ sessionName: 'ckpt-cls-9', source: 'regex', summary: 'primeira', risk: 'high' });
    await new Promise((r) => setImmediate(r));
    watcher.ingestCandidate({ sessionName: 'ckpt-cls-9', source: 'regex', summary: 'segunda (touch)', risk: 'high' });
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(1); // só a criação original disparou; o touch não
  });
});
