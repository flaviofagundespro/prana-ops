/**
 * Camada 3 — classificador GPT 5.6 via delegate Azure OpenAI (Story 2.4, Epic 2).
 *
 * Módulo separado (mesmo padrão de `scanner.mjs`): NÃO acessa SQLite
 * diretamente — toda escrita passa por `watcher.applyClassification` e
 * `watcher.recordEvent`. Usa `fetch` nativo do Node — NENHUM SDK de
 * OpenAI/Azure como dependência (o watcher continua com 1 dependência de
 * runtime, `better-sqlite3`).
 *
 * INVARIANTES:
 *  - Sem env completo (`endpoint`+`apiKey`+`deployment`), a camada fica
 *    DESLIGADA silenciosamente — `maybeClassify` vira no-op (AC2).
 *  - Chave NUNCA é logada, NUNCA vai para `events`/SQLite (AC6): só
 *    metadados de resultado (outcome/risk/reason) são registrados.
 *  - Zero retry automático, timeout duro, 1 chamada em voo por sessão, cap
 *    diário — nenhum loop agressivo contra a Azure (AC5, lição 2026-07-15).
 *  - Falha total da Azure NUNCA derruba o daemon nem bloqueia as camadas
 *    1/2 (AC8) — toda chamada é `try/catch` e best-effort.
 */
import fs from 'node:fs';
import path from 'node:path';

const VALID_STATES = new Set(['thinking', 'waiting_for_input', 'idle', 'error']);
const VALID_RISKS = new Set(['low', 'high']);

const TAIL_MAX_LINES = 30;
/** Leitura limitada aos últimos N bytes — nunca proporcional ao tamanho do arquivo. */
const TAIL_MAX_BYTES = 8_000;

/**
 * Story 2.4/AC7 — prompt constante, instrução explícita de JSON puro e da
 * lista literal de casos `high` do PRD (F6).
 */
export const CLASSIFIER_SYSTEM_PROMPT = `Você é um classificador de estado de sessões de agentes de codificação (Claude Code, Codex) rodando em terminal.
Receberá as últimas linhas de saída do terminal. Responda SOMENTE com um JSON no formato exato, sem nenhum texto fora dele:
{"state": "thinking" | "waiting_for_input" | "idle" | "error", "summary": "resumo de uma linha do que está acontecendo", "risk": "low" | "high"}

Classifique risk="high" quando a decisão pendente envolver: comandos destrutivos (rm, DROP, migrations), deploy, infraestrutura/segredos, ou git force-push.
Na dúvida sobre o risco, responda risk="high".`;

/** AC3 — leitura tolerante: nunca lança, nunca lê proporcionalmente ao tamanho do arquivo. */
export function readTailLines(filePath, maxLines = TAIL_MAX_LINES, maxBytes = TAIL_MAX_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  if (length <= 0) return [];
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-maxLines);
}

/**
 * AC3 — validação ESTRITA do shape: qualquer desvio (JSON inválido, campo
 * faltando, valor fora do domínio) retorna `null` — nunca "melhor esforço".
 */
export function parseClassifierResponse(rawText) {
  let obj;
  try {
    obj = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!VALID_STATES.has(obj.state)) return null;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return null;
  if (!VALID_RISKS.has(obj.risk)) return null;
  return { state: obj.state, summary: obj.summary.trim().slice(0, 200), risk: obj.risk };
}

/**
 * `fetchImpl` é injetável (default: `fetch` global) — único ponto de
 * substituição usado pelos testes para mockar a Azure sem rede real.
 */
export function createClassifier({ watcher, logsDir, config, fetchImpl = fetch }) {
  const endpoint = config.endpoint;
  const apiKey = config.apiKey;
  const deployment = config.deployment;
  const dailyCap = config.dailyCap ?? 200;
  const timeoutMs = config.timeoutMs ?? 15_000;

  const enabled = Boolean(endpoint && apiKey && deployment);
  const inFlight = new Set();

  async function callAzure(lines) {
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-06-01`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: lines.join('\n') },
          ],
          // SEM `temperature`: achado real em smoke — deployments GPT-5.6
          // (modelo de raciocínio) rejeitam qualquer valor != default (1)
          // com HTTP 400 "Unsupported value". Confiar no default do modelo.
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`azure http ${res.status}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('shape inesperado da resposta da Azure');
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * AC1 — dispara a classificação de um candidato recém-criado.
   * Fire-and-forget do ponto de vista de quem chama (nunca rejeita).
   */
  async function maybeClassify({ sessionName, decisionId }) {
    if (!enabled) return; // AC2 — sem env completo, desligado silenciosamente.
    if (inFlight.has(sessionName)) return; // AC5 — no máx. 1 em voo por sessão.

    if (watcher.countClassifierCallsToday() >= dailyCap) {
      // AC5 — estourou o cap diário: camada dorme, mas o skip fica auditável.
      watcher.recordEvent('classifier', { skipped: 'daily_cap', sessionName, decisionId });
      return;
    }

    inFlight.add(sessionName);
    const requestStartedAt = watcher.now();
    try {
      const filePath = path.join(logsDir, `${sessionName}.log`);
      const lines = readTailLines(filePath);

      let rawText;
      try {
        rawText = await callAzure(lines);
      } catch (err) {
        // AC6/AC8 — falha (rede, 5xx, timeout) é registrada SEM a chave e
        // SEM o conteúdo do prompt; NUNCA derruba o daemon nem retenta.
        watcher.recordEvent('classifier', {
          outcome: 'error',
          reason: err instanceof Error ? err.message : String(err),
          sessionName,
          decisionId,
        });
        return;
      }

      const parsed = parseClassifierResponse(rawText);
      if (!parsed) {
        // AC3 — shape inválido: descarta integralmente, candidato mantém high.
        watcher.recordEvent('classifier', { outcome: 'invalid_shape', sessionName, decisionId });
        return;
      }

      watcher.applyClassification({
        decisionId,
        sessionName,
        summary: parsed.summary,
        risk: parsed.risk,
        state: parsed.state,
        olderThan: requestStartedAt,
      });
      watcher.recordEvent('classifier', {
        outcome: 'success',
        sessionName,
        decisionId,
        risk: parsed.risk,
      });
    } finally {
      inFlight.delete(sessionName);
    }
  }

  return { maybeClassify, isEnabled: () => enabled };
}
