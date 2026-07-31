/**
 * Prana OPS Watcher — daemon mínimo na VPS (Story 2.1, Epic 2).
 *
 * ARQUIVO ÚNICO de lógica (deploy = copiar `watcher.mjs` + instalar a única
 * dependência, `better-sqlite3`): sem imports do server/ do cockpit. SQLite via
 * `better-sqlite3` — MESMO driver da Fase 1, já provado compilando na Azure;
 * `node:sqlite` (builtin experimental) foi descartado porque a toolchain de
 * teste deste monorepo (vite/vitest 5.4/2.1, pinada nos outros workspaces)
 * ainda não o reconhece como builtin (ver Dev Notes da Story 2.1). Roda como
 * serviço systemd sempre-on; é onde as camadas de detecção (2.2–2.4), o
 * Telegram (2.5) e o sync do app (2.6) se pluggam. Uma decisão registrada
 * aqui sobrevive ao app fechado — a dor original do PRD.
 *
 * INVARIANTES (não relaxar):
 *  - Escuta SOMENTE 127.0.0.1 (host fixo no listen — não configurável): o app
 *    acessa via SSH exec/port-forward; nada exposto publicamente.
 *  - Sessões sem o prefixo literal `ckpt-` nunca geram decisão nem estado —
 *    eventos delas ficam só em `events` (auditoria). Mesma semântica estrita
 *    da Fase 1 (case-sensitive, sem trim implícito).
 *  - `risk` ausente/inválido vira `high` (na dúvida, high — PRD F6).
 *  - SQLite é a fila/estado do watcher; NUNCA fonte de verdade de pipeline
 *    (F9) — pipeline vem do contrato PRANA, que entra pelo MESMO POST /hook
 *    com outro payload (campo `source`).
 */
import http from 'node:http';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createScanner } from './scanner.mjs';
import { createClassifier } from './classifier.mjs';
import { createNotifier } from './telegram.mjs';

/** Prefixo allowlist — cópia literal da semântica de server/src/tmux/session-name.ts. */
export const CKPT_PREFIX = 'ckpt-';

export function isCkptSession(name) {
  return typeof name === 'string' && name.startsWith(CKPT_PREFIX);
}

const VALID_RISKS = new Set(['low', 'high']);
const VALID_STATES = new Set(['thinking', 'waiting_for_input', 'idle', 'error']);
const VALID_DECISION_STATUS = new Set(['pending', 'seen', 'dismissed', 'answered']);

/**
 * Story 2.2/AC5 — mapeamento evento nativo de hook → session_state. Vive aqui
 * (não no script de hook) para que a semântica seja versionada e testável.
 */
const HOOK_EVENT_STATE = {
  notification: 'waiting_for_input',
  permission_request: 'waiting_for_input',
  user_prompt_submit: 'thinking',
  pre_tool_use: 'thinking',
  post_tool_use: 'thinking',
  stop: 'idle',
};

const HOOK_RESUME_EVENTS = new Set([
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'stop',
]);

/**
 * Story 2.14/AC1 — origens possíveis de um `session_state`. Não é o mesmo
 * `source` de `events`/`decisions` (que guarda QUEM mandou: `claude-code`,
 * `codex`, `regex`, `classifier`); aqui a pergunta é outra e mais grossa: **qual
 * CAMADA de detecção escreveu este estado**, porque é isso que decide quem vence
 * quando as duas discordam (F7: hooks > heurística).
 */
export const STATE_SOURCE_HOOK = 'hook';
export const STATE_SOURCE_HEURISTIC = 'heuristic';

/** Story 2.2/AC6 — placeholder quando o hook não traz texto bruto aproveitável. */
const HOOK_DECISION_PLACEHOLDER = '[hook] aguardando input';

/** Tamanho máximo do resumo de decisão — cabe numa notificação de Telegram. */
const HOOK_SUMMARY_MAX = 200;

/**
 * Story 2.13/AC2 — extrai texto PARA HUMANO do payload bruto do hook.
 *
 * O `raw` chega como o stdin nativo do agente, truncado em 2000 B pelo
 * `ckpt-hook.sh`. Antes disso virava `raw.slice(0, 200)` e o operador recebia
 * `{"session_id":"019faa73-…","turn_id":…` no Telegram (achado em campo,
 * 2026-07-28). Cada agente guarda a pergunta num campo diferente:
 *
 *   Claude Code  →  `message`
 *   Codex        →  `tool_input.description`, com `tool_name` + `command` como
 *                   segunda escolha (nem todo pedido traz descrição)
 *
 * Nunca lança e nunca devolve JSON cru: sem campo aproveitável, o placeholder
 * é mais honesto que um despejo de payload.
 */
export function hookSummary(rawText) {
  const raw = typeof rawText === 'string' ? rawText.trim() : '';
  if (!raw) return HOOK_DECISION_PLACEHOLDER;

  if (raw[0] !== '{') return raw.slice(0, HOOK_SUMMARY_MAX);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncado em 2000 B ou malformado — devolver o pedaço seria despejo de JSON.
    return HOOK_DECISION_PLACEHOLDER;
  }
  if (!parsed || typeof parsed !== 'object') return HOOK_DECISION_PLACEHOLDER;

  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const toolInput = parsed.tool_input && typeof parsed.tool_input === 'object' ? parsed.tool_input : {};

  const chosen =
    text(parsed.message) ||
    text(toolInput.description) ||
    text(parsed.reason) ||
    joinToolCall(text(parsed.tool_name), text(toolInput.command));

  return (chosen || HOOK_DECISION_PLACEHOLDER).replace(/\s+/g, ' ').slice(0, HOOK_SUMMARY_MAX);
}

/** `Bash: touch /etc/x` — só a primeira linha do comando; o resto é ruído no alerta. */
function joinToolCall(toolName, command) {
  const firstLine = command.split('\n')[0].trim();
  if (toolName && firstLine) return `${toolName}: ${firstLine}`;
  return firstLine || toolName;
}

/** Corpo máximo aceito no POST /hook — payloads são pequenos por contrato. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Schema-on-boot idempotente (mesmo espírito da Fase 1): seguro rodar em todo
 * start. `events` guarda TODO payload recebido (auditoria/reprocessamento);
 * `decisions` é a fila; `session_state` é o estado corrente por sessão.
 */
export function buildSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_name  TEXT    NOT NULL,
      summary       TEXT    NOT NULL,
      risk          TEXT    NOT NULL DEFAULT 'high',
      state         TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      source        TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);
    CREATE TABLE IF NOT EXISTS session_state (
      session_name  TEXT PRIMARY KEY,
      state         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
      state_since   TEXT,
      source        TEXT NOT NULL DEFAULT 'heuristic'
    );
    CREATE TABLE IF NOT EXISTS dedup (
      hash          TEXT PRIMARY KEY,
      session_name  TEXT NOT NULL,
      first_seen    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
      last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
    );
  `);
  // Story 2.5/AC4 — `notified_at`: CREATE TABLE IF NOT EXISTS não adiciona
  // coluna a uma tabela `decisions` já existente (schema-on-boot idempotente
  // não cobre ALTER). Checagem via pragma antes de alterar, sem depender de
  // capturar erro de "duplicate column" (mais explícito e testável).
  const hasNotifiedAt = db
    .prepare(`PRAGMA table_info(decisions)`)
    .all()
    .some((col) => col.name === 'notified_at');
  if (!hasNotifiedAt) {
    db.exec(`ALTER TABLE decisions ADD COLUMN notified_at TEXT`);
  }
  // Story 2.9/AC1 — `state_since`: MESMO padrão do notified_at, agora para
  // session_state (os bancos das duas VPS já existem com dados). Distinção que
  // motiva a coluna: `updated_at` é HEARTBEAT (avança a cada escrita, e o
  // scanner reescreve `idle` a cada tick), então é impossível saber há quanto
  // tempo um estado NÃO muda — que é justamente o sinal de uma TUI travada.
  // Fica NULL nas linhas pré-existentes: "desconhecido", nunca "há muito
  // tempo" (senão todo mundo viraria `stuck` no primeiro boot pós-deploy).
  const hasStateSince = db
    .prepare(`PRAGMA table_info(session_state)`)
    .all()
    .some((col) => col.name === 'state_since');
  if (!hasStateSince) {
    db.exec(`ALTER TABLE session_state ADD COLUMN state_since TEXT`);
  }
  // Story 2.14/AC1 — `source`: qual CAMADA escreveu o estado corrente. Sem essa
  // informação a precedência do F7 (hooks > heurística) é indecidível na hora da
  // escrita, e o scanner rebaixava `waiting_for_input` de hook para `idle` em
  // segundos (11 ocorrências em `ckpt-soria-claude-1`, 2026-07-29).
  //
  // MESMO padrão idempotente do `notified_at`/`state_since`. Diferença
  // importante: aqui o DEFAULT não é NULL, é `'heuristic'`. Linhas
  // pré-existentes viram `heuristic` — o valor SEGURO, porque preserva
  // exatamente o comportamento atual até que um hook escreva de fato. Assumir
  // `hook` para o legado congelaria estados antigos sem nenhuma evidência de
  // que veio de hook.
  const hasStateSource = db
    .prepare(`PRAGMA table_info(session_state)`)
    .all()
    .some((col) => col.name === 'source');
  if (!hasStateSource) {
    db.exec(`ALTER TABLE session_state ADD COLUMN source TEXT NOT NULL DEFAULT 'heuristic'`);
  }
}

/** Normaliza o risco declarado: fora de {low,high} → high (na dúvida, high). */
export function normalizeRisk(risk) {
  return VALID_RISKS.has(risk) ? risk : 'high';
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Cria o watcher (server + db) SEM iniciar o listen — os testes usam porta 0
 * e o main abaixo usa a porta do env. `dbPath` ':memory:' nos testes.
 */
export function createWatcher({ dbPath }) {
  // Story 2.4 — o classificador precisa do `watcher` já pronto (dependência
  // circular por construção): injetado depois via `setClassifier()`, nunca
  // no construtor. `null` até lá = ingestCandidate não dispara nada (2.1/2.2
  // /2.3 continuam funcionando sem o classificador existir).
  let classifierRef = null;
  // Story 2.5 — mesmo padrão de injeção tardia do classificador (2.4).
  let notifierRef = null;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  buildSchema(db);

  const insertEvent = db.prepare(`INSERT INTO events (source, payload) VALUES (?, ?)`);
  const insertDecision = db.prepare(
    `INSERT INTO decisions (session_name, summary, risk, state, source) VALUES (?, ?, ?, ?, ?)`,
  );
  // Story 2.9/AC1 — dois relógios com semânticas distintas na MESMA linha:
  //  - `updated_at`: heartbeat, avança a cada escrita (inclusive reescrita do
  //    mesmo estado a cada tick do scanner) — "o watcher esteve aqui";
  //  - `state_since`: só avança quando o estado MUDA de fato — "desde quando
  //    está assim". Preservado no CASE quando o estado se repete.
  // Confundir os dois foi o erro que originou esta story: `updated_at` parece
  // frescor mas não é, porque é bumpado mesmo sem transição alguma.
  const upsertState = db.prepare(
    `INSERT INTO session_state (session_name, state, updated_at, state_since, source)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now'), ?)
     ON CONFLICT(session_name) DO UPDATE SET
       state = excluded.state,
       updated_at = strftime('%Y-%m-%d %H:%M:%f','now'),
       state_since = CASE
         WHEN session_state.state = excluded.state AND session_state.state_since IS NOT NULL
           THEN session_state.state_since
         ELSE strftime('%Y-%m-%d %H:%M:%f','now')
       END,
       source = excluded.source`,
  );
  // Story 2.14/AC3 — devolve a autoridade à Camada 2 SEM escrever estado algum.
  // Usado quando o operador responde/descarta pela fila: a evidência de hook foi
  // consumida, mas afirmar `idle` aqui seria inventar calma (o agente
  // provavelmente voltou a trabalhar). Trocar só a origem deixa o scanner
  // retomar no próximo ciclo e diz a verdade no meio tempo. `updated_at` e
  // `state_since` ficam INTACTOS de propósito: não houve transição de estado.
  const releaseStateLock = db.prepare(
    `UPDATE session_state SET source = '${STATE_SOURCE_HEURISTIC}'
     WHERE session_name = ? AND source = '${STATE_SOURCE_HOOK}'`,
  );
  const listDecisions = db.prepare(`SELECT * FROM decisions WHERE status = ? ORDER BY id ASC`);
  const getDecision = db.prepare(`SELECT * FROM decisions WHERE id = ?`);
  const updateDecisionStatus = db.prepare(`UPDATE decisions SET status = ? WHERE id = ?`);
  // Story 2.2/AC7 + 2.3/AC5 — idempotência POR SESSÃO (não por origem): um
  // candidato já pendente para a MESMA sessão, de QUALQUER camada (hook ou
  // regex), é atualizado, nunca duplicado — é assim que o dedup cross-camada
  // exigido pela 2.3/AC5 se satisfaz sem caminho paralelo de escrita (AC6).
  const findOpenDecision = db.prepare(
    `SELECT * FROM decisions WHERE session_name = ? AND status IN ('pending', 'seen') ORDER BY id DESC LIMIT 1`,
  );
  // Story 2.18 — um hook de retomada/conclusão é evidência do agente, não um
  // gesto da UI. Ele encerra toda decisão ainda aberta da sessão de uma vez.
  // A própria linha em `events`, gravada antes desta atualização, é a trilha
  // auditável que explica por que a fila foi drenada.
  const answerOpenDecisions = db.prepare(
    `UPDATE decisions SET status = 'answered'
     WHERE session_name = ? AND status IN ('pending', 'seen')`,
  );
  const touchDecision = db.prepare(
    `UPDATE decisions SET summary = ?, created_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`,
  );
  const replaceDecisionFromStructuredHook = db.prepare(
    `UPDATE decisions
     SET summary = ?, risk = ?, state = ?, source = ?,
         created_at = strftime('%Y-%m-%d %H:%M:%f','now')
     WHERE id = ?`,
  );
  // Story 2.4/AC4 — a classificação atualiza summary/risk/state juntos
  // (touchDecision, da 2.2/2.3, só mexe em summary — insuficiente aqui).
  const updateDecisionFromClassifier = db.prepare(
    `UPDATE decisions SET summary = ?, risk = ?, state = ?, created_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`,
  );
  const getSessionState = db.prepare(`SELECT * FROM session_state WHERE session_name = ?`);
  const getDedup = db.prepare(`SELECT * FROM dedup WHERE hash = ?`);
  const insertDedup = db.prepare(`INSERT INTO dedup (hash, session_name) VALUES (?, ?)`);
  const touchDedup = db.prepare(`UPDATE dedup SET last_seen = strftime('%Y-%m-%d %H:%M:%f','now') WHERE hash = ?`);
  // Story 2.4/AC5 — cap diário: conta só chamadas de fato TENTADAS (payload
  // tem `outcome`), não os próprios eventos de "pulei por causa do cap".
  const countClassifierCallsToday = db.prepare(
    `SELECT COUNT(*) AS c FROM events
     WHERE source = 'classifier'
       AND date(created_at) = date('now')
       AND json_extract(payload, '$.outcome') IS NOT NULL`,
  );
  // Story 2.5/AC4 — notified_at previne re-notificação pós-restart.
  const markNotified = db.prepare(
    `UPDATE decisions SET notified_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`,
  );
  const findUnnotifiedPending = db.prepare(
    `SELECT * FROM decisions WHERE status = 'pending' AND notified_at IS NULL ORDER BY id ASC`,
  );
  // Story 2.6/AC2 — payload consolidado para o app: a fila visível (pending +
  // seen; dismissed/answered saem da fila) e o estado de TODAS as sessões,
  // num único round-trip do poll via SSH.
  const listQueueDecisions = db.prepare(
    `SELECT * FROM decisions WHERE status IN ('pending', 'seen') ORDER BY id ASC`,
  );
  const listSessionStates = db.prepare(`SELECT * FROM session_state ORDER BY session_name ASC`);

  /**
   * Story 2.2/AC6+AC7 e 2.3/AC6 — VIA ÚNICA de criação/atualização de
   * candidato a decisão, usada tanto pelo hook (`notification`) quanto pelo
   * scanner de regex (2.3): zero caminho paralelo de escrita no banco.
   */
  function ingestCandidate({
    sessionName,
    source,
    summary,
    risk,
    decisionState = 'waiting_for_input',
    replaceMetadata = false,
    triggerAutomation = true,
    stateSource = STATE_SOURCE_HEURISTIC,
  }) {
    if (!isCkptSession(sessionName)) return null;
    const finalSummary = summary && summary.trim() ? summary.trim() : HOOK_DECISION_PLACEHOLDER;
    const existing = findOpenDecision.get(sessionName);
    let decisionId;
    let created = false;
    if (existing) {
      if (replaceMetadata) {
        replaceDecisionFromStructuredHook.run(
          finalSummary,
          normalizeRisk(risk),
          decisionState,
          source,
          existing.id,
        );
      } else {
        touchDecision.run(finalSummary, existing.id);
      }
      decisionId = existing.id;
    } else {
      const result = insertDecision.run(
        sessionName,
        finalSummary,
        normalizeRisk(risk),
        decisionState,
        source,
      );
      decisionId = Number(result.lastInsertRowid);
      created = true;
    }
    // Story 2.14 — `stateSource` é PARÂMETRO, não dedução a partir de `source`:
    // quem chama sabe de que camada é, e um `source` novo (outro agente, outro
    // contrato) não pode virar `hook` por engano num `else`. O default é
    // `heuristic` — o valor que não bloqueia ninguém.
    upsertState.run(sessionName, 'waiting_for_input', stateSource);
    // Story 2.4/AC1 — só candidatos GENUINAMENTE NOVOS disparam classificação
    // (não a cada touch de um pendente já existente); fire-and-forget, nunca
    // bloqueia quem chamou ingestCandidate (hook ou scanner).
    if (created && triggerAutomation && classifierRef) {
      void classifierRef.maybeClassify({ sessionName, decisionId });
    }
    // Story 2.5/AC1 — mesma disciplina: só candidato NOVO dispara notificação
    // imediata (fire-and-forget); a varredura periódica do notifier (AC4)
    // cobre o caso de crash entre criação e envio.
    if (created && triggerAutomation && notifierRef) {
      void notifierRef.maybeNotify({ sessionName, decisionId });
    }
    return decisionId;
  }

  /**
   * Story 2.3/AC7 — cascata de precedência (F7: hooks > heurística): só
   * escreve o estado heurístico (thinking/idle) se NENHUM estado mais
   * recente que o ÚLTIMO SCAN (`olderThan` — o `asOf` do ciclo anterior,
   * não do atual) já existir. Um hook que chegou DEPOIS do último scan
   * concluído é mais fresco que a heurística corrente e não é rebaixado;
   * um scan de graça depois, se nada novo de hook chegar, a heurística
   * volta a operar normalmente.
   */
  function applyHeuristicState({ sessionName, state, olderThan }) {
    if (!isCkptSession(sessionName)) return;
    const existing = getSessionState.get(sessionName);
    if (existing && existing.updated_at > olderThan) return;
    // Story 2.18 — hooks agora cobrem o ciclo inteiro (entrada, ferramentas,
    // espera e parada). Enquanto a origem corrente for hook, bytes de repaint,
    // attach e mouse jamais podem reclassificar a sessão. A autoridade só muda
    // por outro hook ou por uma ação explícita na fila legada.
    if (existing && existing.source === STATE_SOURCE_HOOK) return;
    upsertState.run(sessionName, state, STATE_SOURCE_HEURISTIC);
  }

  /**
   * Story 2.3/AC5 — dedup obrigatória por construção: hash das últimas
   * linhas + janela de tempo, persistida (sobrevive a restart). Retorna
   * `true` se o hash já foi visto DENTRO da janela (duplicata a suprimir).
   */
  function checkAndRecordDedup({ hash, sessionName, windowMs, asOf }) {
    const existing = getDedup.get(hash);
    if (!existing) {
      insertDedup.run(hash, sessionName);
      return false;
    }
    const asOfMs = Date.parse(`${asOf.replace(' ', 'T')}Z`);
    const lastSeenMs = Date.parse(`${existing.last_seen.replace(' ', 'T')}Z`);
    const isDuplicate = asOfMs - lastSeenMs <= windowMs;
    touchDedup.run(hash);
    return isDuplicate;
  }

  /** Story 2.4/AC6 — registro genérico em `events`, reusado pelo classificador. */
  function recordEvent(source, payload) {
    insertEvent.run(source, JSON.stringify(payload));
  }

  /**
   * Story 2.4/AC4 — aplica o resultado do classificador: summary/risk/state
   * da DECISÃO são sempre atualizados (é o próprio propósito da camada 3).
   * `session_state` da SESSÃO, porém, passa pelo MESMO guard de precedência
   * da heurística (F7: hooks > heurística > classificador) — reaproveitado
   * aqui com `olderThan` = o instante em que a chamada à Azure foi disparada,
   * então qualquer hook/scan mais recente que isso vence o classificador.
   */
  function applyClassification({ decisionId, sessionName, summary, risk, state, olderThan }) {
    const decision = getDecision.get(decisionId);
    if (!decision || decision.status !== 'pending') return; // já respondida/descartada nesse meio tempo
    updateDecisionFromClassifier.run(summary, normalizeRisk(risk), state, decisionId);
    applyHeuristicState({ sessionName, state, olderThan });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Nenhum request pode derrubar o daemon (ele é o guardião das decisões).
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      // db aberto e respondendo = saudável (uma query barata prova os dois).
      const ok = db.prepare('SELECT 1 AS one').get()?.one === 1;
      json(res, 200, { ok: true, db: ok });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hook') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        json(res, 400, { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const source = typeof payload.source === 'string' && payload.source ? payload.source : 'unknown';
      // TODO payload é auditado, inclusive de sessões fora da allowlist.
      insertEvent.run(source, JSON.stringify(payload));

      const sessionName = payload.session_name;
      const allowed = isCkptSession(sessionName);
      let decisionId = null;
      if (allowed) {
        // Story 2.14/AC3 — TODA escrita que entra por aqui é Camada 1 e é
        // SOBERANA: sem guarda, sem precedência, sobrescreve o que estiver lá.
        // É por isso que a sessão volta a `idle` quando o `stop` chega — sem
        // esta incondicionalidade ela ficaria âmbar para sempre, que é o defeito
        // espelhado do que a story corrige.
        if (typeof payload.state === 'string' && VALID_STATES.has(payload.state)) {
          upsertState.run(sessionName, payload.state, STATE_SOURCE_HOOK);
        }

        // Story 2.2/AC5 — hooks nativos (Claude/Codex) mandam `event`, não
        // `state`; o mapeamento é decidido AQUI, não no script do hook.
        const hookState =
          typeof payload.event === 'string' ? HOOK_EVENT_STATE[payload.event] : undefined;
        if (hookState) {
          upsertState.run(sessionName, hookState, STATE_SOURCE_HOOK);
        }

        // O hook prova retomada ou conclusão. Drenar aqui evita a fila fantasma
        // sem depender de abrir aba, focar terminal ou clicar no cockpit.
        if (typeof payload.event === 'string' && HOOK_RESUME_EVENTS.has(payload.event)) {
          answerOpenDecisions.run(sessionName);
        }

        // Indício de decisão = objeto `decision` com summary não-vazio.
        const d = payload.decision;
        if (d && typeof d === 'object' && typeof d.summary === 'string' && d.summary.trim()) {
          decisionId = ingestCandidate({
            sessionName,
            source,
            summary: d.summary,
            risk: d.risk,
            decisionState: typeof d.state === 'string' ? d.state : null,
            replaceMetadata: true,
            triggerAutomation: false,
            stateSource: STATE_SOURCE_HOOK,
          });
        } else if (hookState === 'waiting_for_input') {
          // Story 2.2/AC6+AC7 — evidência de hook é alta confiança, não
          // certeza (PRD F4/Camada 1): sintetiza candidato `risk=high` pela
          // via única (ingestCandidate, 2.3/AC6), que já é idempotente por
          // sessão (não duplica um pendente aberto por QUALQUER camada).
          decisionId = ingestCandidate({
            sessionName,
            source,
            summary: hookSummary(payload.raw),
            risk: 'high',
            stateSource: STATE_SOURCE_HOOK,
          });
        }
      }
      json(res, 200, { ok: true, allowed, decisionId });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      // Story 2.6/AC2 — 1 poll = 1 round-trip: fila + estados juntos. Só
      // sessões ckpt- existem em session_state por construção (allowlist na
      // escrita), então não há filtro adicional aqui.
      json(res, 200, {
        ok: true,
        decisions: listQueueDecisions.all(),
        sessions: listSessionStates.all(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/decisions') {
      const status = url.searchParams.get('status') ?? 'pending';
      if (!VALID_DECISION_STATUS.has(status)) {
        json(res, 400, { error: `invalid status: ${status}` });
        return;
      }
      json(res, 200, listDecisions.all(status));
      return;
    }

    const patchMatch = /^\/decisions\/(\d+)$/.exec(url.pathname);
    if (req.method === 'PATCH' && patchMatch) {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        json(res, 400, { error: 'invalid JSON' });
        return;
      }
      const id = Number(patchMatch[1]);
      if (!VALID_DECISION_STATUS.has(body.status)) {
        json(res, 400, { error: `invalid status: ${String(body.status)}` });
        return;
      }
      if (!getDecision.get(id)) {
        json(res, 404, { error: 'decision not found' });
        return;
      }
      updateDecisionStatus.run(body.status, id);
      // Story 2.14/AC3 — o operador agiu (respondeu ou descartou): a evidência
      // de hook que blindava o `waiting_for_input` foi consumida. Devolver a
      // autoridade à Camada 2 evita o defeito espelhado (âmbar eterno se o
      // `stop` do agente não chegar). Só quando NÃO sobra pendente para a
      // sessão — duas decisões abertas e respondendo uma não encerra a espera.
      // `seen` não libera nada: ver não é responder.
      const decision = getDecision.get(id);
      if ((body.status === 'answered' || body.status === 'dismissed') && decision) {
        if (!findOpenDecision.get(decision.session_name)) {
          releaseStateLock.run(decision.session_name);
        }
      }
      json(res, 200, getDecision.get(id));
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  return {
    server,
    db,
    // Expostos para reuso do scanner de regex (2.3) e do classificador (2.4)
    // — mesma via de escrita usada pelo /hook (2.2), zero caminho paralelo (AC6).
    ingestCandidate,
    applyHeuristicState,
    checkAndRecordDedup,
    applyClassification,
    recordEvent,
    countClassifierCallsToday: () => countClassifierCallsToday.get().c,
    setClassifier(c) {
      classifierRef = c;
    },
    // Story 2.5 — reuso do mesmo padrão para o notificador Telegram.
    getDecision: (id) => getDecision.get(id),
    markNotified: (id) => markNotified.run(id),
    findUnnotifiedPending: () => findUnnotifiedPending.all(),
    setNotifier(n) {
      notifierRef = n;
    },
    /** Timestamp no MESMO formato/timezone de `updated_at`/`last_seen` (UTC). */
    now() {
      return db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS t`).get().t;
    },
    /**
     * INVARIANTE AC2: host é LITERAL '127.0.0.1' — não existe parâmetro de
     * host. Expor o watcher exigiria editar o código, não uma config.
     */
    start(port) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// Entrypoint do systemd (não roda sob os testes, que importam createWatcher).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.WATCHER_PORT ?? 4100);
  const dbPath =
    process.env.WATCHER_DB ?? path.join(process.env.HOME ?? '/tmp', '.cockpit', 'watcher.db');
  const watcher = createWatcher({ dbPath });
  void watcher.start(port).then((addr) => {
    console.log(`[watcher] Prana OPS watcher on http://127.0.0.1:${addr.port} (db: ${dbPath})`);
  });

  // Story 2.3 — Camada 2 (regex + dedup): scanner incremental dos logs
  // pipe-pane, mesma via de escrita do hook (2.2), zero caminho paralelo.
  const logsDir =
    process.env.WATCHER_LOGS_DIR ?? path.join(process.env.HOME ?? '/tmp', '.cockpit', 'logs');
  const scanner = createScanner({
    watcher,
    isCkptSession,
    logsDir,
    config: {
      stallMs: Number(process.env.WATCHER_STALL_MS ?? 120_000),
      dedupWindowMs: Number(process.env.WATCHER_DEDUP_WINDOW_MS ?? 600_000),
      dedupLines: Number(process.env.WATCHER_DEDUP_LINES ?? 5),
      longMsgMinLines: Number(process.env.WATCHER_LONG_MSG_MIN_LINES ?? 5),
    },
  });
  scanner.startPolling(Number(process.env.WATCHER_SCAN_MS ?? 5000));

  // Story 2.4 — Camada 3 (classificador): desligado silenciosamente se as 3
  // env vars não estiverem completas (AC2). Injeção tardia via setClassifier
  // por causa da dependência circular watcher<->classifier (ver Dev Notes).
  const classifier = createClassifier({
    watcher,
    logsDir,
    config: {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_KEY,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      dailyCap: Number(process.env.WATCHER_LLM_DAILY_CAP ?? 200),
      timeoutMs: Number(process.env.WATCHER_LLM_TIMEOUT_MS ?? 15_000),
    },
  });
  watcher.setClassifier(classifier);

  // Story 2.5 — notificador Telegram: desligado silenciosamente sem as 2 env
  // vars (AC2). Injeção tardia via setNotifier (mesmo padrão do classificador).
  const notifier = createNotifier({
    watcher,
    config: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      retryDelayMs: Number(process.env.WATCHER_TELEGRAM_RETRY_MS ?? 30_000),
    },
  });
  watcher.setNotifier(notifier);
  notifier.startSweep(Number(process.env.WATCHER_TELEGRAM_SWEEP_MS ?? 30_000));

  const shutdown = () => {
    scanner.stopPolling();
    notifier.stopSweep();
    void watcher.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
