/**
 * Cobertura da sessão (Story 2.9) — "o watcher está mesmo olhando para isto?"
 *
 * A Fase 2 não vendeu detecção: vendeu **poder ir embora tranquilo**. Isso
 * depende de uma premissa que o app afirmava sem ter. Até esta story,
 * `resolveSessionStatus` fechava com `watcherState ?? 'idle'` — ou seja, uma
 * sessão que NINGUÉM está vigiando ficava visualmente idêntica a uma sessão
 * vigiada e calma. Ausência de informação virava afirmação de calma, que é
 * exatamente a fabricação que o próprio `session-status.ts` diz não cometer
 * (Constitution, Artigo IV — No Invention).
 *
 * ESTE MÓDULO NÃO INFERE ESTADO DE AGENTE (F9). Ele olha apenas METADADO DO
 * SINAL — se há watcher, se o watcher conhece a sessão, e há quanto tempo o
 * estado não muda. O conteúdo do terminal nunca é lido aqui.
 *
 * ## Por que só três motivos de "sem sinal"
 *
 * O que NÃO está aqui é tão deliberado quanto o que está. Duas hipóteses foram
 * investigadas e descartadas por serem ambíguas — e um indicador ambíguo grita
 * lobo em sessão saudável, queimando a confiança que ele existe para construir:
 *
 *  - **`updated_at` obsoleto** não detecta pipe-pane morto: o scanner reescreve
 *    `idle` a cada tick, então o heartbeat avança mesmo com o cano entupido
 *    (incidente de 2026-07-17). Por isso a coluna `state_since` foi criada.
 *  - **log parado** não distingue pipe morto de sessão legitimamente ociosa —
 *    um `bash` parado à noite congela o log igualzinho. Isso é resolvido pela
 *    CURA (re-armar o pipe, Story 2.10), não por detecção mais esperta.
 */

import type { SessionStateItem, WatcherSessionStateName } from '../ws-protocol.js';
import type { SessionCacheStatus } from './session-status.js';

/**
 * Veredicto de cobertura. `covered` é o único que autoriza o operador a ler o
 * silêncio como informação.
 */
export type SessionCoverage =
  | 'covered'
  | 'no_watcher'
  | 'no_pipe'
  | 'no_hooks'
  | 'hooks_unsupported'
  | 'unknown'
  | 'stuck';

/**
 * Limiar de `stuck`: tempo em `thinking` SEM transição a partir do qual a
 * sessão passa a ser suspeita de estar esperando input sem avisar — o caso
 * 2026-07-21, em que o Claude Code (TUI de tela cheia) repinta continuamente,
 * o gatilho de prompt-parado nunca dispara e o estado congela em `thinking`.
 *
 * Conservador de propósito (AC7): preferir falso-negativo a falso-positivo.
 * Um agente pode legitimamente pensar por muitos minutos; um alarme que dispara
 * nesse caso ensina o operador a ignorar o indicador — que é o pior desfecho
 * possível para uma feature cujo produto é confiança.
 */
export const STUCK_THINKING_MS = 20 * 60 * 1000;

/** Entrada da derivação — tudo que o front já recebe, nada inferido. */
export interface CoverageInput {
  /** Liveness do `tmux ls` (Fase 1): a fonte de "está viva" (F9). */
  cacheStatus: SessionCacheStatus;
  /** `false` = perfil sem watcher acessível; `undefined` = ainda não reportado. */
  watcherAvailable: boolean | undefined;
  /** Item do watcher para a sessão; `undefined` = watcher não a conhece. */
  stateItem: SessionStateItem | undefined;
  /**
   * Story 2.10/AC5 — o cockpit tentou re-armar o `pipe-pane` desta sessão e
   * desistiu após N tentativas. É o ÚNICO caso em que o app acusa cano morto:
   * antes disso ele está curando em silêncio, e alarmar seria ruído sobre algo
   * que se resolve sozinho em ~10s.
   */
  pipeUnrecoverable?: boolean;
  /**
   * Story 2.11/AC3 — o agente desta sessão iniciou ANTES dos hooks serem
   * instalados, então roda sem eles. Para agentes de TUI a Camada 2 é
   * estruturalmente cega, logo o watcher não detecta `waiting_for_input` aqui.
   * A cura (reiniciar o agente) destrói o contexto da conversa e é decisão do
   * operador — esta flag INFORMA, nunca dispara ação.
   */
  agentWithoutHooks?: boolean;
  /**
   * Story 2.12 — o agente em uso NÃO lê `~/.claude/settings.json` (Codex).
   * Distinto de {@link agentWithoutHooks}: lá reciclar a sessão resolve; aqui
   * não resolve nada, é limitação do agente (HOOKS.md §3).
   */
  hooksUnsupported?: boolean;
  /** Agora, injetável para teste. */
  nowMs: number;
  /** Sobrescreve o limiar de `stuck` (default {@link STUCK_THINKING_MS}). */
  stuckThresholdMs?: number;
}

/**
 * Converte o timestamp do watcher (`'YYYY-MM-DD HH:MM:SS.mmm'`, UTC, sem
 * timezone explícito) em epoch ms. Mesmo tratamento que o watcher usa na
 * dedup: trocar o espaço por `T` e marcar `Z`. Retorna `undefined` para
 * ausente/ilegível — ausência NUNCA deve virar "há muito tempo".
 */
export function parseWatcherTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Deriva a cobertura. Ordem das regras é significativa:
 *
 * 1. **Sessão morta vence tudo** — sumiu do `tmux ls` não é "sem sinal", é erro
 *    (AC5); o tmux continua sendo a fonte de "está viva" (F9).
 * 2. **Sem watcher no perfil** — nada daquela VPS está sendo vigiado.
 * 3. **Watcher não conhece a sessão** — no ar, mas cego para esta sessão
 *    (sem hook e sem log: nunca chegou a vê-la). Exige `watcherAvailable ===
 *    true`: um perfil que NUNCA reportou (`undefined`) não é evidência de
 *    ausência, e alarmar sobre ele seria alarmar sobre nada (AC7).
 * 4. **Congelada em `thinking`** — só com `stateSince` conhecido; ausente
 *    (watcher não migrado, ou linha anterior à migração) resolve para
 *    `covered`, nunca para `stuck`.
 */
export function deriveCoverage({
  cacheStatus,
  watcherAvailable,
  stateItem,
  nowMs,
  pipeUnrecoverable,
  agentWithoutHooks,
  hooksUnsupported,
  stuckThresholdMs = STUCK_THINKING_MS,
}: CoverageInput): SessionCoverage {
  if (cacheStatus === 'error') return 'covered';
  if (watcherAvailable === false) return 'no_watcher';
  // Story 2.10/AC5 — vem ANTES de `unknown`: se o cano não sobe, a razão de o
  // watcher não conhecer a sessão é justamente essa, e dizer "cano morto" é
  // mais acionável que dizer "não conheço".
  if (pipeUnrecoverable === true) return 'no_pipe';
  // Story 2.11/AC5 — depois de `no_pipe` (sem cano, o cano é o problema maior)
  // e ANTES de `unknown`/`stuck`: a falta de hook EXPLICA por que o watcher não
  // conhece a sessão, ou por que o estado congelou em `thinking`.
  if (agentWithoutHooks === true) return 'no_hooks';
  // Story 2.12: mesma posição de precedência — também explica `unknown`/`stuck`
  // —, mas com conselho OPOSTO, por isso é um veredicto separado.
  if (hooksUnsupported === true) return 'hooks_unsupported';
  // `=== true` e não truthy: `undefined` significa "ainda não sei", e "não sei"
  // não pode virar alarme — do contrário toda sessão apareceria como sem sinal
  // no primeiro render, antes do primeiro sync chegar.
  if (!stateItem) return watcherAvailable === true ? 'unknown' : 'covered';

  if (stateItem.state === 'thinking') {
    const since = parseWatcherTime(stateItem.stateSince);
    if (since !== undefined && nowMs - since >= stuckThresholdMs) return 'stuck';
  }
  return 'covered';
}

/**
 * Texto do motivo, para `title`/`aria-label`. Sugere sem afirmar no caso
 * `stuck` — o app não tem como saber que o agente está travado, só que o
 * estado não muda há muito tempo.
 */
export function coverageReason(coverage: SessionCoverage, sinceMs?: number): string | undefined {
  switch (coverage) {
    case 'no_watcher':
      return 'sem watcher neste perfil — nenhuma sessão desta VPS está sendo vigiada';
    case 'no_pipe':
      return 'pipe-pane não sobe nesta sessão — o cockpit tentou re-armar e desistiu; o watcher está cego aqui';
    case 'no_hooks':
      return 'o agente iniciou antes dos hooks — o watcher não detecta decisão aqui; reciclar a sessão ativa a detecção (a conversa é retomável com --resume)';
    case 'hooks_unsupported':
      return 'não há hook instalado para este agente na VPS — reciclar não resolve; o watcher não detecta decisão nesta sessão (instalar o hook resolve, ver HOOKS.md §3)';
    case 'unknown':
      return 'o watcher não conhece esta sessão — ela pode estar sem hook e sem log';
    case 'stuck':
      return `em "thinking" há ${formatDuration(sinceMs)} sem mudar — pode estar esperando input sem avisar`;
    default:
      return undefined;
  }
}

/** Duração curta e legível (`45min`, `3h`, `2d`) para o tooltip. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return 'muito tempo';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Conveniência para a UI: cobertura + quanto tempo no estado atual, numa
 * chamada só (a UI precisa dos dois juntos para montar o tooltip).
 */
export function describeCoverage(input: CoverageInput): {
  coverage: SessionCoverage;
  reason: string | undefined;
} {
  const coverage = deriveCoverage(input);
  const since = parseWatcherTime(input.stateItem?.stateSince);
  const elapsed = since === undefined ? undefined : input.nowMs - since;
  return { coverage, reason: coverageReason(coverage, elapsed) };
}

/** Re-export para quem só precisa do nome do estado (conveniência de import). */
export type { WatcherSessionStateName };
