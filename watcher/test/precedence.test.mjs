/**
 * Story 2.14 — precedência entre camadas: a Camada 1 (hooks) vence a Camada 2
 * (regex) quando as duas discordam sobre `waiting_for_input`.
 *
 * Em 2026-07-21 já se havia concluído que, para agentes de TUI de tela cheia, a
 * fonte de verdade tem de ser o hook: a tela é redesenhada inteira, então "sem
 * saída nova" não distingue *trabalhando* de *esperando*. A conclusão estava
 * escrita e o código não a implementava — o guard do scanner protegia o estado
 * por UM ciclo de scan. Em 2026-07-29 isso custou onze `permission_request`
 * rebaixados para `idle` em segundos, numa única sessão, ao longo de duas horas.
 *
 * DB `:memory:`, sem servidor HTTP onde não é preciso: a precedência é decidida
 * em `applyHeuristicState`, não na rede.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createWatcher,
  buildSchema,
  STATE_SOURCE_HOOK,
  STATE_SOURCE_HEURISTIC,
} from '../watcher.mjs';

let watcher;
let baseUrl;

beforeEach(async () => {
  watcher = createWatcher({ dbPath: ':memory:' });
  const addr = await watcher.start(0);
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await watcher.stop();
});

function postHook(payload) {
  return fetch(`${baseUrl}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((res) => res.json());
}

function stateOf(sessionName) {
  return watcher.db.prepare(`SELECT * FROM session_state WHERE session_name = ?`).get(sessionName);
}

/** Uma `boundary` no futuro do último write = o que o scanner passa no ciclo SEGUINTE. */
function nextCycleBoundary() {
  return watcher.now();
}

describe('Story 2.14 — a Camada 1 vence a Camada 2', () => {
  it('AC1: `session_state` grava a ORIGEM do estado', () => {
    const columns = watcher.db.prepare(`PRAGMA table_info(session_state)`).all();
    const source = columns.find((c) => c.name === 'source');
    expect(source).toBeDefined();
    expect(source.notnull).toBe(1);
  });

  it('AC1: migração é idempotente e preserva as linhas existentes como `heuristic`', () => {
    // Simula o banco EM PRODUÇÃO na Azure: tabela sem a coluna nova, com dados.
    const legacy = createWatcher({ dbPath: ':memory:' });
    legacy.db.exec(`DROP TABLE session_state`);
    legacy.db.exec(`
      CREATE TABLE session_state (
        session_name TEXT PRIMARY KEY,
        state        TEXT NOT NULL,
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
        state_since  TEXT
      );
      INSERT INTO session_state (session_name, state) VALUES ('ckpt-legado-1', 'waiting_for_input');
    `);

    buildSchema(legacy.db);
    buildSchema(legacy.db); // duas vezes: idempotência

    const row = legacy.db.prepare(`SELECT * FROM session_state WHERE session_name = ?`).get('ckpt-legado-1');
    // O estado sobreviveu à migração...
    expect(row.state).toBe('waiting_for_input');
    // ...e a origem é a SEGURA: linha legada não vira `hook` sem evidência,
    // senão o primeiro boot pós-deploy congelaria estados antigos.
    expect(row.source).toBe(STATE_SOURCE_HEURISTIC);
    legacy.db.close();
  });

  it('AC1: a fila de decisões atravessa a migração intacta', () => {
    const legacy = createWatcher({ dbPath: ':memory:' });
    legacy.db
      .prepare(`INSERT INTO decisions (session_name, summary, risk, state, source) VALUES (?, ?, ?, ?, ?)`)
      .run('ckpt-fila-1', 'Aprovar deploy?', 'high', 'waiting_for_input', 'codex');

    buildSchema(legacy.db);

    const pending = legacy.db.prepare(`SELECT * FROM decisions WHERE status = 'pending'`).all();
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toBe('Aprovar deploy?');
    legacy.db.close();
  });

  it('AC6 (a prova da story): reproduz 2026-07-29 — hook às 12:17:56, scanner 6s depois', async () => {
    const session = 'ckpt-acme-claude-1';

    // 12:17:56 — o Codex pede permissão e o hook chega.
    await postHook({ source: 'codex', session_name: session, event: 'permission_request' });
    const afterHook = stateOf(session);
    expect(afterHook.state).toBe('waiting_for_input');
    expect(afterHook.source).toBe(STATE_SOURCE_HOOK);

    // 12:18:02 — ciclo seguinte do scanner. A `boundary` já é MAIS RECENTE que o
    // `updated_at` do hook, então a guarda de um ciclo não protege mais nada: é
    // exatamente aqui que o estado virava `idle`. Para uma TUI o scanner sempre
    // cai no `else` de "nenhum padrão casou".
    const boundary = nextCycleBoundary();
    expect(boundary > afterHook.updated_at).toBe(true);
    watcher.applyHeuristicState({ sessionName: session, state: 'idle', olderThan: boundary });

    const after = stateOf(session);
    expect(after.state).toBe('waiting_for_input');
    expect(after.source).toBe(STATE_SOURCE_HOOK);
    // `state_since` intacto: a dor começou quando o hook chegou, não agora.
    expect(after.state_since).toBe(afterHook.state_since);
  });

  it('AC2/AC5: nem depois de MUITOS ciclos a heurística afirma calma', async () => {
    const session = 'ckpt-acme-claude-1';
    await postHook({ source: 'codex', session_name: session, event: 'permission_request' });

    // Onze ciclos — o número de pedidos rebaixados na manhã de 2026-07-29.
    for (let i = 0; i < 11; i += 1) {
      watcher.applyHeuristicState({
        sessionName: session,
        state: 'idle',
        olderThan: nextCycleBoundary(),
      });
    }

    // NUNCA vira `idle` por decurso de prazo. Continuar âmbar é o
    // comportamento honesto: o pedido não foi respondido.
    expect(stateOf(session).state).toBe('waiting_for_input');
  });

  it('AC3: o hook segue soberano sobre si — `stop` devolve a sessão a `idle`', async () => {
    const session = 'ckpt-acme-claude-1';
    await postHook({ source: 'codex', session_name: session, event: 'permission_request' });
    expect(stateOf(session).state).toBe('waiting_for_input');

    // Sem isto a sessão ficaria âmbar para sempre — o defeito espelhado.
    await postHook({ source: 'codex', session_name: session, event: 'stop' });
    expect(stateOf(session).state).toBe('idle');
    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);
  });

  it('Story 2.18: depois do `stop`, bytes não inventam `thinking`', async () => {
    const session = 'ckpt-acme-claude-1';
    await postHook({ source: 'codex', session_name: session, event: 'permission_request' });
    await postHook({ source: 'codex', session_name: session, event: 'stop' });

    // Crescimento do log também acontece por attach, mouse e repaint.
    watcher.applyHeuristicState({
      sessionName: session,
      state: 'thinking',
      olderThan: nextCycleBoundary(),
    });
    expect(stateOf(session).state).toBe('idle');
    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);

    // A próxima entrada real do agente é que acende o azul.
    await postHook({ source: 'codex', session_name: session, event: 'user_prompt_submit' });
    expect(stateOf(session).state).toBe('thinking');
    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);
  });

  it('AC3: responder pela fila devolve a autoridade à Camada 2', async () => {
    const session = 'ckpt-resp-1';
    const { decisionId } = await postHook({
      source: 'codex',
      session_name: session,
      event: 'permission_request',
    });
    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);

    await fetch(`${baseUrl}/decisions/${decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'answered' }),
    });

    // Autoridade liberada SEM afirmar estado nenhum: continua `waiting_for_input`
    // até que alguém tenha evidência do contrário.
    const released = stateOf(session);
    expect(released.state).toBe('waiting_for_input');
    expect(released.source).toBe(STATE_SOURCE_HEURISTIC);

    // ...e agora o scanner consegue seguir a sessão de novo.
    watcher.applyHeuristicState({
      sessionName: session,
      state: 'thinking',
      olderThan: nextCycleBoundary(),
    });
    expect(stateOf(session).state).toBe('thinking');
  });

  it('AC3: `seen` NÃO libera — ver não é responder', async () => {
    const session = 'ckpt-visto-1';
    const { decisionId } = await postHook({
      source: 'codex',
      session_name: session,
      event: 'permission_request',
    });

    await fetch(`${baseUrl}/decisions/${decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'seen' }),
    });

    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);
    watcher.applyHeuristicState({
      sessionName: session,
      state: 'idle',
      olderThan: nextCycleBoundary(),
    });
    expect(stateOf(session).state).toBe('waiting_for_input');
  });

  it('AC3: com DUAS decisões abertas, responder uma não encerra a espera', async () => {
    const session = 'ckpt-duas-1';
    const first = await postHook({ source: 'codex', session_name: session, event: 'permission_request' });
    // Segunda decisão explícita (o `ingestCandidate` é idempotente por sessão).
    watcher.db
      .prepare(`INSERT INTO decisions (session_name, summary, risk, state, source) VALUES (?, ?, ?, ?, ?)`)
      .run(session, 'Segundo pedido', 'high', 'waiting_for_input', 'codex');

    await fetch(`${baseUrl}/decisions/${first.decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'answered' }),
    });

    expect(stateOf(session).source).toBe(STATE_SOURCE_HOOK);
  });

  it('AC4: sessão SEM hooks não regride — a Camada 2 segue dona do estado', () => {
    const session = 'ckpt-sem-hook-1';

    // Ninguém nunca chamou /hook para esta sessão: só o scanner a conhece.
    watcher.applyHeuristicState({ sessionName: session, state: 'thinking', olderThan: watcher.now() });
    expect(stateOf(session).state).toBe('thinking');
    expect(stateOf(session).source).toBe(STATE_SOURCE_HEURISTIC);

    // Ciclo seguinte: log silenciou, nenhum padrão casou → `idle`, como antes.
    watcher.applyHeuristicState({ sessionName: session, state: 'idle', olderThan: nextCycleBoundary() });
    expect(stateOf(session).state).toBe('idle');

    // E `waiting_for_input` por regex (prompt clássico de CLI) também continua.
    watcher.applyHeuristicState({
      sessionName: session,
      state: 'waiting_for_input',
      olderThan: nextCycleBoundary(),
    });
    expect(stateOf(session).state).toBe('waiting_for_input');
    // Origem heurística: o próprio scanner pode reavaliar no ciclo seguinte.
    watcher.applyHeuristicState({ sessionName: session, state: 'idle', olderThan: nextCycleBoundary() });
    expect(stateOf(session).state).toBe('idle');
  });

  it('AC2: a guarda de UM ciclo (2.3/AC7) continua valendo, para as duas origens', () => {
    const session = 'ckpt-guarda-1';
    watcher.applyHeuristicState({ sessionName: session, state: 'thinking', olderThan: watcher.now() });

    // `boundary` ANTERIOR à escrita ⇒ o estado é mais fresco que o último scan
    // concluído e não é sobrescrito. Defesa contra corrida, não precedência —
    // por isso vale para as duas origens. Uma data fixa no passado evita a
    // colisão de milissegundo que um `now()` capturado no mesmo tick produz.
    const boundaryNoPassado = '2000-01-01 00:00:00.000';
    expect(stateOf(session).updated_at > boundaryNoPassado).toBe(true);
    watcher.applyHeuristicState({ sessionName: session, state: 'idle', olderThan: boundaryNoPassado });
    expect(stateOf(session).state).toBe('thinking');
  });

  it('candidato por regex NÃO se disfarça de hook', () => {
    const session = 'ckpt-regex-1';
    // Como o scanner chama: sem `stateSource`.
    watcher.ingestCandidate({ sessionName: session, source: 'regex', summary: 'Aprovar? [y/n]', risk: 'high' });

    expect(stateOf(session).state).toBe('waiting_for_input');
    expect(stateOf(session).source).toBe(STATE_SOURCE_HEURISTIC);
    // Logo o próprio scanner pode rebaixar depois — a heurística é reversível.
    watcher.applyHeuristicState({ sessionName: session, state: 'idle', olderThan: nextCycleBoundary() });
    expect(stateOf(session).state).toBe('idle');
  });
});
