/**
 * Watcher tests (Story 2.1, AC9): DB :memory:, porta efêmera (0), fetch real
 * contra o servidor — nenhum recurso externo. Cobrem: schema idempotente,
 * POST /hook (evento sempre; decisão SÓ ckpt-*), fila por status, PATCH,
 * health e o invariante de bind 127.0.0.1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWatcher, buildSchema, isCkptSession, normalizeRisk } from '../watcher.mjs';

let watcher;
let baseUrl;

beforeEach(async () => {
  watcher = createWatcher({ dbPath: ':memory:' });
  const addr = await watcher.start(0); // porta efêmera
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await watcher.stop();
});

async function postHook(payload) {
  const res = await fetch(`${baseUrl}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe('watcher scaffolding (Story 2.1)', () => {
  it('binds to 127.0.0.1 only (AC2 — invariante de segurança)', () => {
    expect(watcher.server.address().address).toBe('127.0.0.1');
  });

  it('schema-on-boot é idempotente (AC5)', () => {
    // Rodar de novo sobre o MESMO db não pode lançar nem apagar dados.
    watcher.db.exec(`INSERT INTO events (source, payload) VALUES ('x', '{}')`);
    buildSchema(watcher.db);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(1);
  });

  it('GET /health responde ok com db vivo (AC6)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });

  it('POST /hook grava evento + decisão pending para sessão ckpt-* (AC3)', async () => {
    const { status, body } = await postHook({
      source: 'claude-hook',
      session_name: 'ckpt-prana-claude-1',
      decision: { summary: 'Aprovar migration da tabela X?', risk: 'low' },
    });
    expect(status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.decisionId).toBeGreaterThan(0);

    const pending = await (await fetch(`${baseUrl}/decisions?status=pending`)).json();
    expect(pending).toHaveLength(1);
    expect(pending[0].session_name).toBe('ckpt-prana-claude-1');
    expect(pending[0].risk).toBe('low');
    expect(pending[0].source).toBe('claude-hook');
    // Decisão pendente ⇒ sessão esperando input.
    const st = watcher.db.prepare('SELECT state FROM session_state WHERE session_name = ?')
      .get('ckpt-prana-claude-1');
    expect(st.state).toBe('waiting_for_input');
  });

  it('sessão NÃO-ckpt vira evento (auditoria) mas NUNCA decisão nem estado (AC4)', async () => {
    const { body } = await postHook({
      source: 'regex',
      session_name: '4terminal',
      decision: { summary: 'não deveria entrar na fila' },
      state: 'waiting_for_input',
    });
    expect(body.allowed).toBe(false);
    expect(body.decisionId).toBeNull();
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(1);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c).toBe(0);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM session_state').get().c).toBe(0);
  });

  it('hook estruturado repetido é idempotente e preserva os metadados mais recentes', async () => {
    const first = await postHook({
      source: 'x',
      session_name: 'ckpt-a-claude-1',
      decision: { summary: 'primeira', risk: 'low', state: 'approval' },
    });
    const second = await postHook({
      source: 'claude-hook',
      session_name: 'ckpt-a-claude-1',
      decision: { summary: 'segunda', risk: 'medium', state: 'confirm' },
    });
    const rows = await (await fetch(`${baseUrl}/decisions?status=pending`)).json();
    expect(second.body.decisionId).toBe(first.body.decisionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      summary: 'segunda',
      risk: 'high',
      state: 'confirm',
      source: 'claude-hook',
    });
  });

  it('payload só de estado atualiza session_state sem criar decisão (AC3/AC5)', async () => {
    await postHook({ source: 'hook', session_name: 'ckpt-b-codex-1', state: 'thinking' });
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c).toBe(0);
    const st = watcher.db.prepare('SELECT state FROM session_state WHERE session_name = ?')
      .get('ckpt-b-codex-1');
    expect(st.state).toBe('thinking');
  });

  it('PATCH /decisions/:id atualiza status; id inexistente → 404 (AC6)', async () => {
    const { body } = await postHook({
      source: 'x',
      session_name: 'ckpt-c-claude-1',
      decision: { summary: 's' },
    });
    const patch = await fetch(`${baseUrl}/decisions/${body.decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).status).toBe('dismissed');
    // Saiu da fila pending.
    expect(await (await fetch(`${baseUrl}/decisions?status=pending`)).json()).toHaveLength(0);

    const missing = await fetch(`${baseUrl}/decisions/9999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'seen' }),
    });
    expect(missing.status).toBe(404);
  });

  it('JSON inválido → 400 sem derrubar o daemon (AC3)', async () => {
    const res = await fetch(`${baseUrl}/hook`, { method: 'POST', body: 'not json{' });
    expect(res.status).toBe(400);
    // Daemon segue vivo.
    expect((await (await fetch(`${baseUrl}/health`)).json()).ok).toBe(true);
  });
});

describe('GET /state — payload consolidado para o app (Story 2.6, AC2)', () => {
  it('devolve fila + estados de todas as sessões num round-trip só', async () => {
    await postHook({
      source: 'hook',
      session_name: 'ckpt-a-claude-1',
      decision: { summary: 'Aprovar deploy?', risk: 'high' },
    });
    await postHook({ source: 'hook', session_name: 'ckpt-b-codex-1', state: 'thinking' });

    const body = await (await fetch(`${baseUrl}/state`)).json();
    expect(body.ok).toBe(true);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].session_name).toBe('ckpt-a-claude-1');
    expect(body.decisions[0].risk).toBe('high');
    // Ambas as sessões aparecem no estado (a com decisão está waiting_for_input).
    expect(body.sessions.map((s) => [s.session_name, s.state])).toEqual([
      ['ckpt-a-claude-1', 'waiting_for_input'],
      ['ckpt-b-codex-1', 'thinking'],
    ]);
  });

  it('fila visível = pending + seen; dismissed sai (AC5 — ações do painel)', async () => {
    const a = await postHook({
      source: 'x',
      session_name: 'ckpt-a-claude-1',
      decision: { summary: 'primeira' },
    });
    // Segunda decisão em OUTRA sessão (pendente por sessão é idempotente).
    const b = await postHook({
      source: 'x',
      session_name: 'ckpt-b-claude-1',
      decision: { summary: 'segunda' },
    });
    await fetch(`${baseUrl}/decisions/${a.body.decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'seen' }),
    });
    await fetch(`${baseUrl}/decisions/${b.body.decisionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' }),
    });

    const body = await (await fetch(`${baseUrl}/state`)).json();
    expect(body.decisions.map((d) => [d.id, d.status])).toEqual([[a.body.decisionId, 'seen']]);
  });
});

/**
 * Story 2.9 (AC1/AC2/AC9) — `state_since` vs `updated_at`.
 *
 * A distinção é o ponto da story: `updated_at` é heartbeat (o scanner reescreve
 * `idle` a cada tick), então NÃO serve para "há quanto tempo está assim". Sem
 * `state_since` é impossível ver uma TUI congelada em `thinking` — o incidente
 * de 2026-07-21, em que o agente esperava input e ninguém foi avisado.
 */
describe('session_state: state_since (Story 2.9)', () => {
  const SESSION = 'ckpt-prana-claude-1';

  function row(sessionName = SESSION) {
    return watcher.db.prepare(`SELECT * FROM session_state WHERE session_name = ?`).get(sessionName);
  }

  // O guard de precedência de applyHeuristicState pula a escrita quando
  // `existing.updated_at > olderThan`. O scanner passa a fronteira do tick
  // ANTERIOR (sempre posterior à última escrita), então a escrita passa; nos
  // testes um sentinela no futuro reproduz esse caminho sem depender do relógio.
  const ALWAYS = '9999-12-31 23:59:59.999';
  function write(state, sessionName = SESSION) {
    watcher.applyHeuristicState({ sessionName, state, olderThan: ALWAYS });
  }

  /** Garante um tick de relógio: `strftime('%f')` tem resolução de ms. */
  async function nextMs() {
    await new Promise((r) => setTimeout(r, 3));
  }

  it('reescrever o MESMO estado avança updated_at mas PRESERVA state_since', async () => {
    write('idle');
    const first = row();
    expect(first.state_since).toBeTruthy();

    await nextMs();
    // olderThan no passado → o guard de precedência deixa a escrita passar,
    // exatamente como o scanner faz a cada tick numa sessão em silêncio.
    write('idle');
    const second = row();

    expect(second.updated_at > first.updated_at).toBe(true); // heartbeat avançou
    expect(second.state_since).toBe(first.state_since); // ...mas o estado é o mesmo desde antes
  });

  it('transição de estado AVANÇA state_since', async () => {
    write('idle');
    const before = row();

    await nextMs();
    write('thinking');
    const after = row();

    expect(after.state).toBe('thinking');
    expect(after.state_since > before.state_since).toBe(true);
  });

  it('mil ticks de idle não movem state_since (o cenário real do scanner)', async () => {
    write('idle');
    const origin = row().state_since;
    for (let i = 0; i < 50; i += 1) {
      write('idle');
    }
    await nextMs();
    write('idle');
    expect(row().state_since).toBe(origin);
  });

  it('AC2: GET /state devolve state_since junto de cada sessão', async () => {
    write('thinking');
    const body = await (await fetch(`${baseUrl}/state`)).json();
    const entry = body.sessions.find((s) => s.session_name === SESSION);
    expect(entry.state).toBe('thinking');
    expect(entry.state_since).toBeTruthy();
  });

  it('AC1: migração é idempotente sobre banco PRÉ-EXISTENTE sem a coluna', async () => {
    // Reproduz o banco que já roda nas duas VPS: session_state no formato
    // anterior, com dados. buildSchema tem de adicionar a coluna sem perder
    // linha alguma — e rodar de novo não pode quebrar.
    const legacy = createWatcher({ dbPath: ':memory:' });
    legacy.db.exec(`DROP TABLE session_state`);
    legacy.db.exec(`
      CREATE TABLE session_state (
        session_name  TEXT PRIMARY KEY,
        state         TEXT NOT NULL,
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
      );
      INSERT INTO session_state (session_name, state) VALUES ('ckpt-antiga-claude-1', 'idle');
    `);

    buildSchema(legacy.db);
    buildSchema(legacy.db); // idempotência

    const cols = legacy.db
      .prepare(`PRAGMA table_info(session_state)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain('state_since');

    const preserved = legacy.db
      .prepare(`SELECT * FROM session_state WHERE session_name = 'ckpt-antiga-claude-1'`)
      .get();
    expect(preserved.state).toBe('idle');
    // Linha anterior à migração fica NULL: "desconhecido", nunca "há muito
    // tempo" — senão viraria alarme falso no primeiro boot pós-deploy.
    expect(preserved.state_since).toBeNull();
  });

  it('linha legada NULL passa a contar a partir da primeira escrita pós-deploy', async () => {
    watcher.db.exec(
      `INSERT INTO session_state (session_name, state, state_since) VALUES ('${SESSION}', 'idle', NULL)`,
    );
    write('idle');
    // Mesmo estado, mas state_since era NULL → adota o instante da escrita em
    // vez de permanecer nulo para sempre.
    expect(row().state_since).toBeTruthy();
  });
});

describe('helpers puros', () => {
  it('isCkptSession é estrito (case-sensitive, sem trim)', () => {
    expect(isCkptSession('ckpt-x-claude-1')).toBe(true);
    expect(isCkptSession('Ckpt-x')).toBe(false);
    expect(isCkptSession(' ckpt-x')).toBe(false);
    expect(isCkptSession(undefined)).toBe(false);
  });

  it('normalizeRisk: low/high passam, resto vira high', () => {
    expect(normalizeRisk('low')).toBe('low');
    expect(normalizeRisk('high')).toBe('high');
    expect(normalizeRisk('medium')).toBe('high');
    expect(normalizeRisk(undefined)).toBe('high');
  });
});
