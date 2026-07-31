/**
 * WatcherPoller — sincroniza a fila de decisões e o estado por sessão do
 * watcher da Fase 2 para dentro do app (Story 2.6, AC1/AC2/AC3/AC7).
 *
 * MECANISMO — invariante do projeto: o poller NUNCA fala com o
 * watcher pela rede. Ele executa `curl -s http://127.0.0.1:<porta>/state` NA
 * PRÓPRIA VPS, através do canal de controle SSH da Fase 1 (o MESMO runQuery de
 * canal curto + delimitador do `tmux ls` — exposto como
 * `TmuxSessionManager.runHostQuery`). A porta do watcher jamais atravessa a
 * rede e nenhuma conexão SSH nova é aberta por poll.
 *
 * DEGRADAÇÃO (AC3): VPS sem watcher (curl vazio / JSON inválido / timeout do
 * canal) vira um snapshot `watcherAvailable: false` emitido SÓ NA TRANSIÇÃO
 * (sem spam), e o poll continua com BACKOFF exponencial (AC2) até o watcher
 * aparecer — quando volta, o intervalo normal é restaurado. Nada disso mexe
 * na lógica de reconexão da Fase 1: o ciclo de vida do poller é dirigido de
 * fora (wiring), começando em `connected` e parando em `closed`/`error`.
 *
 * IDENTIDADE (AC7): todo snapshot carrega o `profileId` — a fila agregada no
 * app é por (profileId, sessionName), lição da Fase 1.
 *
 * F9: o poller NÃO infere estado — só transporta o que o watcher já decidiu.
 */
import { EventEmitter } from 'node:events';
import type {
  DecisionQueueItem,
  SessionStateItem,
  WatcherSessionStateName,
} from '../ws/protocol.js';

/** Superfície mínima do canal de controle (TmuxSessionManager.runHostQuery). */
export interface HostQueryRunner {
  runHostQuery(profileId: string, cmd: string): Promise<string | null>;
}

/** Snapshot de um poll: fila + estados de UM perfil, ou indisponibilidade. */
export interface WatcherSnapshot {
  profileId: string;
  watcherAvailable: boolean;
  decisions: DecisionQueueItem[];
  states: SessionStateItem[];
}

export interface WatcherPollerEvents {
  /**
   * Emitido a cada poll BEM-SUCEDIDO e UMA vez na transição para indisponível
   * (AC3 — sem spam de "watcher indisponível" a cada ciclo de backoff).
   */
  snapshot: (snapshot: WatcherSnapshot) => void;
}

export interface WatcherPollerOptions {
  queryRunner: HostQueryRunner;
  /** Porta do watcher NA VPS (o curl roda lá). Default 4100. */
  watcherPort?: number;
  /** Intervalo base de poll (AC2). Default 10000 (10s). */
  intervalMs?: number;
  /** Teto do backoff quando o watcher está indisponível (AC2/AC3). Default 60000. */
  maxIntervalMs?: number;
  /** Injected scheduler/canceller (fake timers nos testes — padrão 1.2/1.3). */
  scheduler?: (fn: () => void, ms: number) => unknown;
  cancelScheduler?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_INTERVAL_MS = 60_000;
const DEFAULT_WATCHER_PORT = 4100;
/** --max-time do curl: menor que o timeout do canal de query (5s), para o
 *  curl falhar limpo (saída vazia) antes de o canal estourar em null. */
const CURL_MAX_TIME_S = 3;

const VALID_STATES: ReadonlySet<string> = new Set([
  'thinking',
  'waiting_for_input',
  'idle',
  'error',
]);
const VALID_QUEUE_STATUS: ReadonlySet<string> = new Set(['pending', 'seen']);
// Story 2.7: 'answered' entra na allowlist do PATCH — usado SÓ pelo responder
// após send-keys confirmado; a decisions:action da UI segue seen/dismissed
// (validação própria no parse do ws).
const VALID_ACTIONS: ReadonlySet<string> = new Set(['seen', 'dismissed', 'answered']);

/** Estado interno de poll por perfil. */
interface ProfilePollState {
  timer: unknown;
  /** Falhas consecutivas — expoente do backoff (AC2). */
  failures: number;
  /** undefined = nunca pollado; controla emissão só-na-transição (AC3). */
  available: boolean | undefined;
  /** Guard de reentrância: um poll lento nunca sobrepõe o próximo tick. */
  polling: boolean;
  lastSnapshot: WatcherSnapshot | null;
}

/**
 * Extrai e valida o JSON do `GET /state` a partir da saída crua do canal
 * (pty:false não ecoa comando, mas a extração `{...}` tolera ruído residual).
 * Qualquer desvio de shape → null (watcher indisponível/incompatível) — nunca
 * lança. Exportada para teste unitário direto.
 */
export function parseStateOutput(
  raw: string,
): { decisions: DecisionQueueItem[]; states: SessionStateItem[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as { ok?: unknown; decisions?: unknown; sessions?: unknown };
  if (body.ok !== true || !Array.isArray(body.decisions) || !Array.isArray(body.sessions)) {
    return null;
  }

  const decisions: DecisionQueueItem[] = [];
  for (const row of body.decisions as Array<Record<string, unknown>>) {
    if (typeof row !== 'object' || row === null) continue;
    const id = Number(row.id);
    const status = String(row.status ?? '');
    if (!Number.isInteger(id) || id <= 0 || !VALID_QUEUE_STATUS.has(status)) continue;
    decisions.push({
      id,
      sessionName: String(row.session_name ?? ''),
      summary: String(row.summary ?? ''),
      // Na dúvida, high — mesma regra do watcher (PRD F6).
      risk: row.risk === 'low' ? 'low' : 'high',
      status: status as DecisionQueueItem['status'],
      // created_at do watcher = "última atualização" (DOC-002 do gate 2.5).
      updatedAt: String(row.created_at ?? ''),
    });
  }

  const states: SessionStateItem[] = [];
  for (const row of body.sessions as Array<Record<string, unknown>>) {
    if (typeof row !== 'object' || row === null) continue;
    const state = String(row.state ?? '');
    if (!VALID_STATES.has(state)) continue;
    // Story 2.9/AC3 — `state_since` só existe em watcher já migrado; um watcher
    // antigo simplesmente não manda o campo, e o front trata a ausência como
    // "desconhecido" (nunca como "há muito tempo"). Por isso `undefined` em vez
    // de string vazia: ausência precisa ser distinguível de valor.
    const stateSince = row.state_since == null ? undefined : String(row.state_since);
    states.push({
      sessionName: String(row.session_name ?? ''),
      state: state as WatcherSessionStateName,
      updatedAt: String(row.updated_at ?? ''),
      ...(stateSince !== undefined ? { stateSince } : {}),
    });
  }

  return { decisions, states };
}

export class WatcherPoller extends EventEmitter {
  private readonly queryRunner: HostQueryRunner;
  private readonly watcherPort: number;
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly scheduler: (fn: () => void, ms: number) => unknown;
  private readonly cancelScheduler: (handle: unknown) => void;

  /** profileId → estado de poll. Presença no Map = poll ativo. */
  private readonly polls = new Map<string, ProfilePollState>();

  constructor(options: WatcherPollerOptions) {
    super();
    this.queryRunner = options.queryRunner;
    this.watcherPort = options.watcherPort ?? DEFAULT_WATCHER_PORT;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.scheduler = options.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelScheduler = options.cancelScheduler ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  // Typed event overloads (mesmo padrão do ConnectionManager/TmuxSessionManager).

  override on<E extends keyof WatcherPollerEvents>(
    event: E,
    listener: WatcherPollerEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof WatcherPollerEvents>(
    event: E,
    ...args: Parameters<WatcherPollerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Inicia o poll do perfil (idempotente). O primeiro poll roda IMEDIATAMENTE
   * — quem acabou de conectar não espera um intervalo inteiro para ver a fila.
   */
  startPolling(profileId: string): void {
    if (this.polls.has(profileId)) return;
    const st: ProfilePollState = {
      timer: undefined,
      failures: 0,
      available: undefined,
      polling: false,
      lastSnapshot: null,
    };
    this.polls.set(profileId, st);
    void this.pollOnce(profileId).finally(() => this.arm(profileId));
  }

  /** Para o poll do perfil (perfil desconectado/removido). */
  stopPolling(profileId: string): void {
    const st = this.polls.get(profileId);
    if (!st) return;
    if (st.timer !== undefined) this.cancelScheduler(st.timer);
    this.polls.delete(profileId);
  }

  /** Para todos os polls (shutdown). */
  stopAllPolling(): void {
    for (const profileId of [...this.polls.keys()]) {
      this.stopPolling(profileId);
    }
  }

  /**
   * Story 2.7 (AC4): decisão corrente no último snapshot do perfil — é daqui
   * (NUNCA do cliente) que o responder lê o risco. undefined = fora do
   * snapshot (o responder trata como high — na dúvida, high).
   */
  findDecision(profileId: string, decisionId: number): DecisionQueueItem | undefined {
    return this.polls
      .get(profileId)
      ?.lastSnapshot?.decisions.find((d) => d.id === decisionId);
  }

  /** Últimos snapshots conhecidos — enviados a sockets recém-conectados. */
  lastSnapshots(): WatcherSnapshot[] {
    const out: WatcherSnapshot[] = [];
    for (const st of this.polls.values()) {
      if (st.lastSnapshot) out.push(st.lastSnapshot);
    }
    return out;
  }

  /** Re-arma o timer com o intervalo corrente (backoff exponencial em falha). */
  private arm(profileId: string): void {
    const st = this.polls.get(profileId);
    if (!st) return; // stopPolling venceu a corrida
    const delay = Math.min(this.intervalMs * 2 ** st.failures, this.maxIntervalMs);
    st.timer = this.scheduler(() => {
      void this.pollOnce(profileId).finally(() => this.arm(profileId));
    }, delay);
  }

  /**
   * Um poll: `curl` do `/state` na VPS via canal SSH. Público para os testes
   * dirigirem deterministicamente (mesmo padrão do reconcileOnce da 1.3).
   */
  async pollOnce(profileId: string): Promise<void> {
    const st = this.polls.get(profileId);
    if (!st || st.polling) return;
    st.polling = true;
    try {
      const output = await this.queryRunner.runHostQuery(
        profileId,
        `curl -s --max-time ${CURL_MAX_TIME_S} http://127.0.0.1:${this.watcherPort}/state`,
      );
      const parsed = output === null ? null : parseStateOutput(output);
      if (parsed === null) {
        st.failures += 1;
        // AC3 — transição para indisponível é emitida UMA vez (sem spam) e a
        // UI degrada para Fase 1; os ticks seguintes em backoff ficam mudos.
        if (st.available !== false) {
          st.available = false;
          const snapshot: WatcherSnapshot = {
            profileId,
            watcherAvailable: false,
            decisions: [],
            states: [],
          };
          st.lastSnapshot = snapshot;
          this.emit('snapshot', snapshot);
        }
        return;
      }
      st.failures = 0;
      st.available = true;
      const snapshot: WatcherSnapshot = {
        profileId,
        watcherAvailable: true,
        decisions: parsed.decisions,
        states: parsed.states,
      };
      st.lastSnapshot = snapshot;
      this.emit('snapshot', snapshot);
    } catch {
      // runHostQuery não lança por contrato (timeout ⇒ null), mas nenhuma
      // falha inesperada pode derrubar o loop (disciplina AC5 da Fase 1).
      st.failures += 1;
    } finally {
      st.polling = false;
    }
  }

  /**
   * Propaga uma ação da fila (AC5): `PATCH /decisions/:id` no watcher DA VPS
   * do perfil, pelo mesmo canal. `decisionId`/`action` são REVALIDADOS aqui
   * (defesa em profundidade — o parse do ws já validou): nada de valor cru do
   * cliente interpolado em comando. Sucesso dispara um poll imediato para o
   * snapshot atualizado chegar a todos os clientes sem esperar o intervalo.
   */
  async patchDecision(
    profileId: string,
    decisionId: number,
    action: 'seen' | 'dismissed' | 'answered',
  ): Promise<boolean> {
    if (!Number.isInteger(decisionId) || decisionId <= 0 || !VALID_ACTIONS.has(action)) {
      return false;
    }
    const body = JSON.stringify({ status: action });
    const output = await this.queryRunner.runHostQuery(
      profileId,
      `curl -s --max-time ${CURL_MAX_TIME_S} -X PATCH ` +
        `http://127.0.0.1:${this.watcherPort}/decisions/${decisionId} ` +
        `-H 'Content-Type: application/json' -d '${body}'`,
    );
    if (output === null) return false;
    // O watcher devolve a decisão atualizada; status ecoado = PATCH aplicado.
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start === -1 || end <= start) return false;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1)) as { status?: unknown };
      const ok = parsed.status === action;
      if (ok) void this.pollOnce(profileId);
      return ok;
    } catch {
      return false;
    }
  }
}
