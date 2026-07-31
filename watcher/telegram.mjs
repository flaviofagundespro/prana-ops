/**
 * Notificação Telegram — a dor que originou o projeto morre aqui: decisão
 * detectada vira mensagem no celular do operador, mesmo com o cockpit fechado.
 * Sem isto, uma sessão bloqueada só é descoberta quando alguém olha a tela.
 *
 * Módulo separado (mesmo padrão de `scanner.mjs`/`classifier.mjs`): não
 * acessa SQLite diretamente — só via `watcher.getDecision`/`markNotified`/
 * `recordEvent`/`findUnnotifiedPending`. `fetch` nativo, sem SDK.
 *
 * INVARIANTES:
 *  - Sem `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, a camada fica DESLIGADA
 *    silenciosamente (AC2, mesmo padrão da 2.4).
 *  - O token NUNCA é logado: ele vai NA URL do Telegram
 *    (`api.telegram.org/bot<TOKEN>/...`) — os eventos gravados registram só
 *    status/motivo, jamais a URL completa (AC2/AC3).
 *  - Envio nunca bloqueia a fila nem derruba o daemon (AC3); retry contido,
 *    nunca agressivo (AC5).
 *  - 1 decisão = 1 notificação: `notified_at` é o guarda contra duplicata
 *    entre restarts (AC4).
 */

const MAX_RETRIES = 2; // AC5 — no máximo 2 tentativas ADICIONAIS (3 no total)

function formatMessage({ sessionName, summary, risk, createdAt }) {
  const riskLabel = risk === 'high' ? 'ALTO ⚠️' : 'baixo';
  return [
    '🔔 Prana OPS — decisão pendente',
    `Sessão: ${sessionName}`,
    `Risco: ${riskLabel}`,
    `Resumo: ${summary}`,
    `Quando: ${createdAt}`,
  ].join('\n');
}

export { formatMessage };

/**
 * `fetchImpl`/`sleepImpl` injetáveis — únicos pontos de substituição usados
 * pelos testes (rede real e espera de 30s não podem rodar na suíte).
 */
export function createNotifier({
  watcher,
  config,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const botToken = config.botToken;
  const chatId = config.chatId;
  const retryDelayMs = config.retryDelayMs ?? 30_000;

  const enabled = Boolean(botToken && chatId);
  const inFlight = new Set();

  async function callTelegram(text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body?.ok) {
      const retryAfter = body?.parameters?.retry_after; // segundos, no 429
      const err = new Error(`telegram http ${res.status}`);
      err.retryAfterMs = typeof retryAfter === 'number' ? retryAfter * 1000 : undefined;
      throw err;
    }
  }

  /**
   * AC1/AC5 — envia com retry contido (máx. 2 tentativas adicionais,
   * espaçamento fixo ≥ `retryDelayMs`, respeitando `retry_after` do 429
   * quando presente). Nunca lança para quem chamou.
   */
  async function sendWithRetry(text, { sessionName, decisionId }) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await callTelegram(text);
        return true;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          const delay = err.retryAfterMs && err.retryAfterMs > retryDelayMs ? err.retryAfterMs : retryDelayMs;
          await sleepImpl(delay);
        }
      }
    }
    // AC3/AC5 — desistiu: motivo auditável, SEM a URL (token nunca vazado).
    watcher.recordEvent('telegram', {
      outcome: 'error',
      reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
      sessionName,
      decisionId,
    });
    return false;
  }

  /**
   * AC1/AC4 — notifica uma decisão pendente ainda não notificada. Idempotente
   * por construção: decisão inexistente, já notificada, ou não-pendente vira
   * no-op silencioso.
   */
  async function maybeNotify({ sessionName, decisionId }) {
    if (!enabled) return; // AC2 — sem env completo, desligado silenciosamente.
    if (inFlight.has(decisionId)) return;

    const decision = watcher.getDecision(decisionId);
    if (!decision || decision.status !== 'pending' || decision.notified_at) return;

    inFlight.add(decisionId);
    try {
      const text = formatMessage({
        sessionName: decision.session_name,
        summary: decision.summary,
        risk: decision.risk,
        createdAt: decision.created_at,
      });
      const ok = await sendWithRetry(text, { sessionName, decisionId });
      if (ok) {
        watcher.markNotified(decisionId);
        watcher.recordEvent('telegram', { outcome: 'success', sessionName, decisionId });
      }
    } finally {
      inFlight.delete(decisionId);
    }
  }

  /**
   * AC4 — varredura de recuperação: cobre decisões criadas mas nunca
   * notificadas (crash do watcher entre criação e envio). Idempotente com
   * o disparo imediato via `inFlight` (mesma sessão/decisão nunca dispara
   * duas chamadas concorrentes).
   */
  async function sweepUnnotified() {
    if (!enabled) return;
    const rows = watcher.findUnnotifiedPending();
    for (const row of rows) {
      await maybeNotify({ sessionName: row.session_name, decisionId: row.id });
    }
  }

  let timer = null;
  return {
    maybeNotify,
    sweepUnnotified,
    isEnabled: () => enabled,
    startSweep(intervalMs) {
      timer = setInterval(() => void sweepUnnotified(), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stopSweep() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
