/**
 * Camada 2 — regex nos logs pipe-pane + dedup obrigatória (Story 2.3, Epic 2).
 *
 * Módulo separado de `watcher.mjs` (decisão de Dev Notes da 2.1/2.3: "se o
 * arquivo passar de ~600 linhas, extrair watcher/scanner.mjs é aceitável SEM
 * quebrar o espírito único-arquivo de lógica"). Este módulo NÃO acessa o
 * SQLite diretamente — toda escrita passa pelas funções do `watcher`
 * (`ingestCandidate`, `applyHeuristicState`, `checkAndRecordDedup`), a MESMA
 * via usada pelo hook (2.2), satisfazendo AC6 (zero caminho paralelo).
 *
 * INVARIANTES:
 *  - Só arquivos `<sessão>.log` cujo nome passa em isCkptSession() são
 *    acompanhados (AC2) — nem `events` é gerado para o resto.
 *  - Leitura SEMPRE incremental por offset — nunca relê o arquivo inteiro
 *    (AC1). No PRIMEIRO encontro de um arquivo, o offset começa no fim
 *    (EOF) — histórico pré-existente nunca vira decisão retroativa.
 *  - Erro em UM arquivo nunca derruba o scan dos demais nem o daemon (AC8).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Máximo de linhas mantidas em memória por sessão (contexto do padrão "?" longo). */
const TAIL_MAX = 50;

/**
 * Remove sequências de escape ANSI (cores/cursor/modos privados como
 * bracketed-paste `\x1B[?2004h`) — pipe-pane captura terminal cru. O `?`
 * opcional cobre sequências de "private mode" (achado real em smoke E2E:
 * sem ele, `\x1B[?2004h` sobrevivia no summary armazenado).
 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[\??[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Padrões de UMA linha (AC3): `[y/N]`, `(yes/no)`, `approve?`, `confirm?`.
 * Cada padrão tem um id para diagnóstico. Retorna null se nada casar.
 */
export function matchDecisionPattern(line) {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;
  if (/\[\s*y\s*\/\s*n\s*\]/i.test(clean)) return 'yn-bracket';
  if (/\(\s*yes\s*\/\s*no\s*\)/i.test(clean)) return 'yn-paren';
  if (/\bapprove\?/i.test(clean)) return 'approve';
  if (/\bconfirm\?/i.test(clean)) return 'confirm';
  return null;
}

function lastNonEmptyIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (stripAnsi(lines[i]).trim() !== '') return i;
  }
  return -1;
}

/**
 * AC3 — "? no fim de mensagem longa": a última linha não-vazia termina em
 * `?` E há pelo menos `minLines` linhas não-vazias contíguas antes dela
 * (bloco anterior). Opera sobre o TAIL BUFFER (não só o delta), pois o
 * bloco pode ter sido escrito em ticks de scan anteriores.
 */
export function matchLongQuestion(tailLines, minLines) {
  const i = lastNonEmptyIndex(tailLines);
  if (i < 0) return null;
  const lastLine = stripAnsi(tailLines[i]).trim();
  if (!lastLine.endsWith('?')) return null;
  let blockCount = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = stripAnsi(tailLines[j]).trim();
    if (t === '') break;
    blockCount++;
  }
  return blockCount >= minLines ? 'long-question' : null;
}

/** AC4 — "prompt parado": última linha não-vazia do tail casa algum padrão. */
export function matchStalledPrompt(tailLines, minLongMsgLines) {
  const i = lastNonEmptyIndex(tailLines);
  if (i < 0) return null;
  return matchDecisionPattern(tailLines[i]) ?? matchLongQuestion(tailLines, minLongMsgLines);
}

/**
 * Junta `carry` (linha parcial do tick anterior) com o novo `chunk`, separa
 * em linhas completas e devolve o restante parcial (sem newline) como novo
 * `carry` — padrão de leitura incremental sem perder fronteiras de linha.
 */
export function splitLines(carry, chunk) {
  const combined = carry + chunk;
  const parts = combined.split('\n');
  const leftover = parts.pop() ?? '';
  return { lines: parts, leftover };
}

/**
 * AC5 — hash das últimas K linhas relevantes, normalizadas (ANSI stripped +
 * trim, vazias descartadas) para que o MESMO prompt com timestamps/cores
 * diferentes não fure a janela de dedup.
 */
export function hashLines(lines) {
  const normalized = lines
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l !== '')
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** AC2 — só `<sessão>.log` cujo nome passa isCkptSession(); ignora o resto por completo. */
export function listCkptLogFiles(logsDir, isCkptSession) {
  let entries;
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ sessionName: f.slice(0, -'.log'.length), filePath: path.join(logsDir, f) }))
    .filter(({ sessionName }) => isCkptSession(sessionName));
}

/**
 * Cria o scanner. `watcher` precisa expor: `ingestCandidate`,
 * `applyHeuristicState`, `checkAndRecordDedup`, `now()`, e `isCkptSession`.
 */
export function createScanner({ watcher, isCkptSession, logsDir, config }) {
  const cfg = {
    stallMs: config.stallMs ?? 120_000,
    dedupWindowMs: config.dedupWindowMs ?? 600_000,
    dedupLines: config.dedupLines ?? 5,
    longMsgMinLines: config.longMsgMinLines ?? 5,
  };

  /** @type {Map<string, { offset: number, carry: string, tailLines: string[], lastDeltaAt: number }>} */
  const fileStates = new Map();

  function forget(sessionName) {
    fileStates.delete(sessionName);
  }

  function processFile(sessionName, filePath, asOf) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // AC8 — arquivo removido: esquecido silenciosamente, sem crash.
      forget(sessionName);
      return;
    }

    let st = fileStates.get(sessionName);
    if (!st) {
      // Primeiro encontro: offset começa no EOF — histórico pré-existente
      // nunca vira decisão retroativa (decisão de design, ver Dev Notes).
      // `boundary` é o "último scan" para efeito da AC7 — arranca no asOf
      // deste primeiro encontro (nada de heurística é escrito ainda).
      st = { offset: stat.size, carry: '', tailLines: [], lastDeltaAt: Date.now(), boundary: asOf };
      fileStates.set(sessionName, st);
      return;
    }
    // AC7 — fronteira do ciclo ANTERIOR (não deste): um hook mais recente
    // que ela vence a heurística deste scan. Atualizada ao final da função.
    const boundary = st.boundary;

    if (stat.size < st.offset) {
      // AC8 — truncado/rotacionado: reseta offset sem crash.
      st.offset = 0;
      st.carry = '';
    }

    let deltaText = '';
    if (stat.size > st.offset) {
      const length = stat.size - st.offset;
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buf, 0, length, st.offset);
      } finally {
        fs.closeSync(fd);
      }
      st.offset = stat.size;
      // Bytes UTF-8 inválidos viram U+FFFD silenciosamente (AC8) — nunca lança.
      deltaText = buf.toString('utf8');
    }

    if (deltaText) {
      const { lines, leftover } = splitLines(st.carry, deltaText);
      st.carry = leftover;
      if (lines.length > 0) {
        st.tailLines.push(...lines);
        if (st.tailLines.length > TAIL_MAX) st.tailLines = st.tailLines.slice(-TAIL_MAX);
        st.lastDeltaAt = Date.now();

        // AC3 — padrões de UMA linha checados SÓ no delta (nunca no histórico
        // já consumido em ticks anteriores).
        let patternId = null;
        let matchedLine = '';
        for (const line of lines) {
          const p = matchDecisionPattern(line);
          if (p) {
            patternId = p;
            matchedLine = line;
            break;
          }
        }
        // "? de mensagem longa" olha o tail (o bloco pode cruzar ticks).
        if (!patternId) {
          patternId = matchLongQuestion(st.tailLines, cfg.longMsgMinLines);
          if (patternId) matchedLine = st.tailLines[lastNonEmptyIndex(st.tailLines)];
        }

        if (patternId) {
          raiseCandidate(sessionName, patternId, matchedLine, st, asOf, boundary);
        } else {
          // AC7 — output fluindo sem padrão de decisão.
          watcher.applyHeuristicState({ sessionName, state: 'thinking', olderThan: boundary });
        }
      }
    } else {
      // Delta vazio: só age depois de STALL_MS de silêncio (AC4).
      const stalledMs = Date.now() - st.lastDeltaAt;
      if (stalledMs >= cfg.stallMs) {
        const patternId = matchStalledPrompt(st.tailLines, cfg.longMsgMinLines);
        if (patternId) {
          const matchedLine = st.tailLines[lastNonEmptyIndex(st.tailLines)] ?? '';
          raiseCandidate(sessionName, patternId, matchedLine, st, asOf, boundary);
        } else {
          watcher.applyHeuristicState({ sessionName, state: 'idle', olderThan: boundary });
        }
      }
    }

    // A fronteira deste ciclo vira o "último scan" para a PRÓXIMA chamada.
    st.boundary = asOf;
  }

  function raiseCandidate(sessionName, patternId, matchedLine, st, asOf, boundary) {
    const hash = hashLines(st.tailLines.slice(-cfg.dedupLines));
    const isDuplicate = watcher.checkAndRecordDedup({ hash, sessionName, windowMs: cfg.dedupWindowMs, asOf });
    if (!isDuplicate) {
      const summary = stripAnsi(matchedLine).trim().slice(0, 200);
      watcher.ingestCandidate({ sessionName, source: 'regex', summary, risk: 'high' });
    } else {
      // Já visto dentro da janela: não duplica a decisão, mas o estado
      // continua refletindo que a sessão está esperando input.
      watcher.applyHeuristicState({ sessionName, state: 'waiting_for_input', olderThan: boundary });
    }
  }

  function scanOnce() {
    const asOf = watcher.now();
    const files = listCkptLogFiles(logsDir, isCkptSession);
    const currentSessions = new Set(files.map((f) => f.sessionName));
    for (const known of fileStates.keys()) {
      if (!currentSessions.has(known)) forget(known);
    }
    for (const { sessionName, filePath } of files) {
      try {
        processFile(sessionName, filePath, asOf);
      } catch (err) {
        // AC8 — erro em UM arquivo nunca derruba o scan dos demais nem o daemon.
        console.error(`[watcher/scanner] erro ao processar ${sessionName}:`, err);
      }
    }
  }

  let timer = null;
  return {
    scanOnce,
    startPolling(intervalMs) {
      timer = setInterval(scanOnce, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
