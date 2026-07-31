/**
 * TmuxSessionManager — the tmux session-orchestration layer (Story 1.3).
 *
 * Sits ON TOP of the Story 1.2 `ConnectionManager` transport. Every tmux
 * operation (new-session, ls, pipe-pane) is a SHELL COMMAND written over a
 * channel that `ConnectionManager.openChannel` already owns. This layer NEVER
 * opens a second SSH connection and NEVER opens a channel outside
 * `connectionManager.openChannel`.
 *
 * KEY INVARIANTS:
 *  - 1 session tmux = 1 channel = 1 terminal, never windows-in-a-session (AC2).
 *  - Only `ckpt-*` sessions are ever created / attached / piped / killed. The
 *    allowlist is enforced at command-construction via `assertCkptSession`
 *    (AC4); there is no code path here that emits a tmux command against a name
 *    that did not pass the guard.
 *  - SQLite `session_metadata` is cache/metadata; liveness ALWAYS comes from a
 *    live `tmux ls` (AC6, AC7, PRD F9).
 *
 * READING `tmux ls` OVER A PTY CHANNEL (ratified decision #1, @po 2026-07-12):
 *  The 1.2 channel is an interactive shell PTY (`client.shell()`), not `exec()`,
 *  so a command has no discrete "result". To read the output of a query command
 *  like `tmux ls`, we:
 *    1. open a SHORT-LIVED query channel via `connectionManager.openChannel`
 *       (same connection — no second path);
 *    2. write `<cmd>; echo '<DELIMITER>'\n`;
 *    3. accumulate `data` events for that channelId until the DELIMITER line
 *       appears (or a timeout fires);
 *    4. slice off everything up to the delimiter, parse, and close the channel.
 *  The delimiter is a fixed unlikely token. A test explicitly feeds the delimiter
 *  string INSIDE the payload to prove the slice logic only reacts to the delimiter
 *  on its OWN line at the end (delimiter-in-payload safety). No `exec()` and no
 *  second connection are introduced (AC9).
 */
import { EventEmitter } from 'node:events';
import {
  assertCkptSession,
  buildSessionName,
  DEFAULT_ASSUNTO,
  isCkptSession,
  parseSessionName,
  shellQuote,
} from './session-name.js';
import type { SessionMetadataRepository } from '../db/session-metadata.js';

/**
 * Minimal view of the `ConnectionManager` this layer consumes. Declaring it as an
 * interface (rather than importing the concrete class) keeps the manager testable
 * with a lightweight fake and documents EXACTLY which transport surface is reused
 * — nothing here can reach for a second connection path.
 */
export interface ChannelTransport {
  /**
   * `pty:false` abre canal de query sem PTY (sem eco/prompt) — SMK-005.
   * `initCommand` é re-executado a cada reabertura pós-reconexão — SMK-010.
   */
  openChannel(profileId: string, opts?: { pty?: boolean; initCommand?: string }): string;
  sendData(profileId: string, channelId: string, data: string): void;
  closeChannel(profileId: string, channelId: string, reason?: string): void;
  /** Subscribe to channel output. Returns nothing; use `off` to detach. */
  on(event: 'data', listener: (p: { profileId: string; channelId: string; data: Buffer }) => void): unknown;
  off(event: 'data', listener: (...args: unknown[]) => void): unknown;
}

/** Injected scheduler (fake timers in tests). Mirrors the 1.2 DI pattern. */
export type Scheduler = (fn: () => void, ms: number) => void;
/** Injected timer canceller. */
export type CancelScheduler = (handle: unknown) => void;

/**
 * Named, configurable map of agent → the shell command that starts it inside the
 * tmux session (ratified decision #3, @po 2026-07-12 — NOT hardcoded inline).
 *
 * ARTICLE IV NOTE: the PRD specifies the *mechanism* (select an agent: claude /
 * codex / free-form command) but NOT the literal binaries. The literal commands
 * below are a documented @dev choice, overridable via constructor options. Any
 * value NOT present as a key is treated as a free-form command and used literally.
 */
export const AGENT_COMMANDS: Readonly<Record<string, string>> = {
  claude: 'claude',
  codex: 'codex',
};

/** Delimiter marking the end of a query command's output on a PTY channel. */
export const QUERY_DELIMITER = '___CKPT_DONE___';

/** Directory (on the VPS) where pipe-pane logs are written. */
export const LOG_DIR = '~/.cockpit/logs';

/**
 * Probe executado na VPS para validar a cobertura REAL dos hooks do Codex.
 *
 * O Codex não confia apenas na presença de uma chave em `config.toml`: o
 * `trusted_hash` precisa ser o SHA-256 da definição normalizada atual. Este
 * script reproduz essa normalização para os cinco hooks do cockpit e só retorna
 * `1` quando cada comando está habilitado e seu hash ainda é válido.
 *
 * Mantido como JavaScript autocontido porque roda no host remoto (onde o
 * servidor TypeScript não está instalado). Exportado para o teste de regressão.
 */
export const CODEX_HOOK_TRUST_PROBE = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const hash = (value) => 'sha256:' + crypto
  .createHash('sha256')
  .update(JSON.stringify(canonical(value)))
  .digest('hex');

const parseHookStates = (toml) => {
  const states = new Map();
  let current = null;
  for (const line of toml.split(/\r?\n/)) {
    const section = line.match(/^\[hooks\.state\."([^"]+)"\]\s*$/);
    if (section) {
      current = { key: section[1], enabled: true, trustedHash: null };
      states.set(current.key, current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trusted = line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"\s*$/);
    if (trusted) current.trustedHash = trusted[1];
    if (/^\s*enabled\s*=\s*false\s*$/.test(line)) current.enabled = false;
  }
  return states;
};

try {
  const home = process.env.CKPT_CODEX_HOME || process.env.HOME;
  if (!home) throw new Error('HOME unavailable');
  const hooksPath = home + '/.codex/hooks.json';
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks || {};
  const states = parseHookStates(fs.readFileSync(home + '/.codex/config.toml', 'utf8'));
  const definitions = [
    ['PermissionRequest', 'permission_request', true, false],
    ['UserPromptSubmit', 'user_prompt_submit', false, true],
    ['PreToolUse', 'pre_tool_use', true, true],
    ['PostToolUse', 'post_tool_use', true, true],
    ['Stop', 'stop', false, false],
  ];

  const eventTrusted = ([jsonEvent, eventName, keepsMatcher, keepsContextLimit]) => {
    const groups = Array.isArray(hooks[jsonEvent]) ? hooks[jsonEvent] : [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex] || {};
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex += 1) {
        const handler = handlers[handlerIndex] || {};
        const expectedCommand = home + '/.cockpit/ckpt-hook.sh ' + eventName + ' codex-hook';
        if (handler.type !== 'command' || handler.command !== expectedCommand || handler.async === true) continue;

        const timeoutValue = handler.timeout == null ? 600 : Number(handler.timeout);
        if (!Number.isSafeInteger(timeoutValue) || timeoutValue < 0) continue;
        const normalizedHandler = {
          type: 'command',
          command: handler.command,
          timeout: Math.max(1, timeoutValue),
          async: false,
        };
        if (typeof handler.statusMessage === 'string') {
          normalizedHandler.statusMessage = handler.statusMessage;
        }
        if (keepsContextLimit && handler.additionalContextLimit != null) {
          const limit = Number(handler.additionalContextLimit);
          if (!Number.isSafeInteger(limit) || limit < 0) continue;
          if (limit !== 2500) normalizedHandler.additionalContextLimit = limit;
        }

        const identity = { event_name: eventName, hooks: [normalizedHandler] };
        if (keepsMatcher && typeof group.matcher === 'string') identity.matcher = group.matcher;
        const key = hooksPath + ':' + eventName + ':' + groupIndex + ':' + handlerIndex;
        const state = states.get(key);
        if (state && state.enabled && state.trustedHash === hash(identity)) return true;
      }
    }
    return false;
  };

  process.stdout.write(definitions.every(eventTrusted) ? '1' : '0');
} catch {
  process.stdout.write('0');
}
`;

const CODEX_HOOK_TRUST_PROBE_BASE64 = Buffer.from(CODEX_HOOK_TRUST_PROBE, 'utf8').toString('base64');

/**
 * Rótulo de exibição inicial de uma sessão nova: "tema-n" (ex.: "auto-1").
 * Decisão de produto (2026-07-15): a identidade do trabalho é projeto+tema —
 * o projeto já é o cabeçalho do grupo na sidebar (não se repete no label) e o
 * CLI usado é ferramenta do momento, dispensável no rótulo.
 *
 * STORY 2.12: sem tema, o fallback era o AGENTE — e foi exatamente ele que
 * produziu os três rótulos `claude-1` enganosos (dois deles em sessões que
 * rodavam Codex). O fallback passa a ser {@link DEFAULT_ASSUNTO}, igual ao do
 * nome: um rótulo honestamente genérico é melhor que um específico e errado.
 *
 * Preserva as abreviações digitadas (apenas lowercase e espaços → '-'). É SÓ
 * apresentação — nunca entra em comando tmux (o nome real segue
 * `buildSessionName`).
 */
export function buildSessionLabel(
  assunto: string | null | undefined,
  _agente: string,
  n: number,
): string {
  const tema = (assunto ?? '').trim() || DEFAULT_ASSUNTO;
  return [tema, String(n)]
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter((s) => s.length > 0)
    .join('-');
}

export interface TmuxSessionManagerOptions {
  transport: ChannelTransport;
  metadata: SessionMetadataRepository;
  /** Override the agent→command map (ratified decision #3). Defaults to {@link AGENT_COMMANDS}. */
  agentCommands?: Readonly<Record<string, string>>;
  /** Reconciliation interval in ms (AC6). Default 10000 (~10s). */
  reconcileIntervalMs?: number;
  /** Timeout for a query command's output (ms). Default 5000. */
  queryTimeoutMs?: number;
  /** Story 2.10/AC4 — tentativas de re-arme antes de desistir. Default 3. */
  maxPipeRearmAttempts?: number;
  /** Injected scheduler for the reconcile loop + query timeouts. Defaults to setTimeout. */
  scheduler?: Scheduler;
  /** Injected canceller. Defaults to clearTimeout. */
  cancelScheduler?: CancelScheduler;
}

export interface TmuxSessionManagerEvents {
  /**
   * A known `ckpt-*` session disappeared from `tmux ls` between reconcile cycles
   * (killed by OOM / manual kill). Its metadata `status` is set to `error`.
   *
   * NOTE: named `sessionError`, NOT `error` — same EventEmitter caution as the
   * 1.2 `channelError` (a listener-less `error` event throws and crashes).
   */
  sessionError: (payload: { profileId: string; sessionName: string }) => void;
  /** A brand-new `ckpt-*` session was adopted from `tmux ls` (AC3). */
  sessionAdopted: (payload: { profileId: string; sessionName: string }) => void;
  /**
   * Story 2.10/AC6 — o cano de uma sessão estava morto (`pane_pipe=0`) e foi
   * re-armado. Mesma cautela de nome dos eventos acima: NUNCA `error` puro.
   */
  pipeRearmed: (payload: { profileId: string; sessionName: string; attempt: number }) => void;
  /**
   * Story 2.10/AC4 — o re-arme falhou `maxPipeRearmAttempts` vezes seguidas: o
   * cockpit desiste até o cano voltar sozinho, e a UI passa a acusar `no_pipe`.
   */
  pipeUnrecoverable: (payload: { profileId: string; sessionName: string }) => void;
}

const DEFAULT_RECONCILE_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/**
 * Story 2.10/AC4 — tentativas consecutivas de re-arme antes de desistir. Sem
 * teto, uma sessão que não aceita o pipe receberia um comando a cada 10s para
 * sempre. Ao desistir, o cockpit não fica em silêncio: a UI passa a acusar
 * `no_pipe` — é a promessa da 2.9 fechando (só acusa depois da cura falhar).
 */
const DEFAULT_MAX_PIPE_REARM_ATTEMPTS = 3;

export class TmuxSessionManager extends EventEmitter {
  private readonly transport: ChannelTransport;
  private readonly metadata: SessionMetadataRepository;
  private readonly agentCommands: Readonly<Record<string, string>>;
  private readonly reconcileIntervalMs: number;
  private readonly queryTimeoutMs: number;
  private readonly scheduler: Scheduler;
  private readonly cancelScheduler: CancelScheduler;

  /** profileId → reconcile timer handle, so reconciliation can be stopped. */
  private readonly reconcileTimers = new Map<string, unknown>();

  /**
   * Story 2.10/AC4 — `profileId sessionName` → tentativas consecutivas de
   * re-arme sem sucesso. Zerado assim que o cano volta a `pipe=1`, para que uma
   * sessão que se recupera volte a ter direito ao ciclo completo de tentativas.
   */
  private readonly pipeRearmAttempts = new Map<string, number>();

  /** Story 2.11/AC3 — profileId → sessões cujo agente roda sem hooks. */
  private readonly hookless = new Map<string, Set<string>>();

  /** Story 2.12 — profileId → sessões cujo agente não lê esses hooks. */
  private readonly hooksUnsupported = new Map<string, Set<string>>();
  private readonly maxPipeRearmAttempts: number;

  constructor(options: TmuxSessionManagerOptions) {
    super();
    this.transport = options.transport;
    this.metadata = options.metadata;
    this.agentCommands = options.agentCommands ?? AGENT_COMMANDS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.maxPipeRearmAttempts =
      options.maxPipeRearmAttempts ?? DEFAULT_MAX_PIPE_REARM_ATTEMPTS;
    this.scheduler = options.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelScheduler = options.cancelScheduler ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  // Typed event overloads ---------------------------------------------------

  override on<E extends keyof TmuxSessionManagerEvents>(
    event: E,
    listener: TmuxSessionManagerEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof TmuxSessionManagerEvents>(
    event: E,
    ...args: Parameters<TmuxSessionManagerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Resolves the shell command that starts `agente` inside the tmux session
   * (ratified decision #3). Known agents map through {@link AGENT_COMMANDS};
   * anything else is treated as a free-form command and used literally.
   */
  resolveAgentCommand(agente: string): string {
    // SMK-011 (smoke E2E): agentes CONHECIDOS resolvem case-insensitive —
    // "Claude" digitado no formulário virava comando livre literal `Claude`
    // (inexistente) e a sessão tmux morria no nascimento. Comandos livres
    // (chaves desconhecidas) seguem literais, sem normalização.
    return this.agentCommands[agente] ?? this.agentCommands[agente.toLowerCase()] ?? agente;
  }

  /**
   * Computes the next free session index for a `ckpt-<projeto>-<agente>-<n>`
   * family on a profile, based on existing metadata (max known index + 1, or 1
   * if none). Cache-derived and best-effort — attach-or-create means colliding on
   * an existing name simply re-attaches, so this never has to be perfectly unique.
   */
  nextSessionIndex(profileId: string, projeto: string, assunto: string): number {
    // Story 2.12: o índice conta por (projeto, ASSUNTO) — `-2` passa a
    // significar "segunda onda de trabalho neste mesmo assunto".
    const prefix = buildSessionName(projeto, assunto, 0).replace(/0$/, '');
    let max = 0;
    for (const row of this.metadata.listByProfile(Number(profileId))) {
      if (!row.sessionName || !row.sessionName.startsWith(prefix)) continue;
      const parsed = parseSessionName(row.sessionName);
      if (parsed && parsed.n > max) max = parsed.n;
    }
    return max + 1;
  }

  /**
   * Creates (or attaches to) the session `ckpt-<projeto>-<agente>-<n>` over ONE
   * channel and starts the agent inside it (AC1, AC2, AC9). Also enables
   * pipe-pane logging from creation (AC5) and records/updates metadata (AC7).
   *
   * Uses exactly 1 channel (1 tmux session = 1 channel = 1 terminal). Returns the
   * session name and the channelId the caller (ws layer) can hand to a terminal.
   */
  createOrAttach(
    profileId: string,
    projeto: string,
    agente: string,
    n: number,
    extra?: { agenda?: string | null },
  ): { sessionName: string; channelId: string; project: string; label: string } {
    // Story 2.12/AC1: o nome vem de projeto + ASSUNTO (a `agenda`), não do
    // agente. O CLI é ferramenta do momento; o assunto é o trabalho. O nome é
    // interface — o operador entra por `tmux ls` do celular, sem o cockpit.
    // buildSessionName sanitizes + guarantees the ckpt- allowlist (AC4).
    const sessionName = buildSessionName(projeto, extra?.agenda ?? '', n);
    assertCkptSession(sessionName); // command-construction guard (belt-and-suspenders)

    // DECISÃO DE PRODUTO (usuário, 2026-07-14, durante o smoke E2E): projeto/
    // pauta/agente são APENAS rótulos (nome da sessão + metadados). A sessão
    // nasce num shell puro dentro do tmux — o operador entra, navega até a
    // pasta desejada e ativa o agente manualmente. Nenhum comando de agente é
    // executado na criação (também elimina o risco de PATH em sh -c).
    //
    // attach-or-create numa ÚNICA linha encadeada (SMK-006/SMK-010 do smoke E2E):
    //  - `mkdir -p` garante o diretório de logs (sem ele o pipe-pane falhava
    //    silenciosamente — SMK-006);
    //  - `\;` encadeia o pipe-pane como comando tmux ATÔMICO ao new-session.
    //    Antes, o pipe-pane era enviado como 2ª linha de shell e acabava
    //    digitado DENTRO da sessão (no agente) — nunca executava;
    //  - `pipe-pane -o` é idempotente (só abre se não houver pipe ativo).
    // A linha é idempotente por inteiro, então também serve de initCommand:
    // reaberturas de canal pós-reconexão re-executam o attach (SMK-010).
    // Toda interpolação é citada (2026-07-30): o nome chega do protocolo e a
    // gramática de `isCkptSession` é a primeira camada, não a única.
    const logPath = `${LOG_DIR}/${sessionName}.log`;
    const attachCmd =
      `mkdir -p ${LOG_DIR}; ` +
      `tmux new-session -A -s ${shellQuote(sessionName)} \\; ` +
      `pipe-pane -o ${shellQuote(`cat >> ${logPath}`)}`;

    // ONE channel for this session (AC2, AC9). Reuse of the profile connection is
    // entirely inside openChannel — no second connection path here.
    const channelId = this.transport.openChannel(profileId, {
      initCommand: `${attachCmd}\n`,
    });

    this.transport.sendData(profileId, channelId, `${attachCmd}\n`);

    // Metadata (cache only). Upsert by (profile, session name) so re-attach
    // doesn't dup — scoped per profile because the same tmux name may exist on
    // two VPS at once (tmux namespaces are per host).
    const existing = this.metadata.getByProfileAndSessionName(Number(profileId), sessionName);
    let label: string;
    let project: string;
    if (existing) {
      this.metadata.update(existing.id, {
        agent: agente,
        status: 'active',
        // Story 2.12: reabrir NÃO sobrescreve a agenda existente. O caminho de
        // reabertura manda o assunto já sanitizado (vindo do nome), e gravá-lo
        // por cima degradaria o texto original ("Watcher do prana" → "watcher").
        ...(extra?.agenda !== undefined && !existing.agenda ? { agenda: extra.agenda } : {}),
      });
      // Re-attach nunca sobrescreve um label editado pelo usuário.
      label = existing.label?.trim() || buildSessionLabel(existing.agenda, agente, n);
      project = existing.project ?? projeto;
    } else {
      label = buildSessionLabel(extra?.agenda, agente, n);
      project = projeto;
      this.metadata.create({
        profileId: Number(profileId),
        project: projeto,
        agenda: extra?.agenda ?? null,
        agent: agente,
        sessionName,
        // Rótulo inicial "tema-n" com o tema COMO O USUÁRIO DIGITOU.
        label,
        status: 'active',
      });
    }

    return { sessionName, channelId, project, label };
  }

  /**
   * Runs `tmux ls` on the profile and returns the list of `ckpt-*` session names
   * found (AC3, AC4). Non-`ckpt-` sessions are filtered OUT via `isCkptSession`,
   * so the cockpit never even *names* a user's manual session. Malformed output
   * is tolerated (never throws): unparseable lines are ignored.
   */
  async listCkptSessions(profileId: string): Promise<string[] | null> {
    // `-F '#{session_name}'` yields one bare session name per line.
    const output = await this.runQuery(profileId, `tmux ls -F '#{session_name}'`);
    // null = consulta não confiável (timeout/canal morto) — o chamador decide;
    // NUNCA é equivalente a "nenhuma sessão" (SMK-004).
    if (output === null) return null;
    return parseSessionList(output);
  }

  /**
   * Story 2.10/AC1 — estado do `pipe-pane` por sessão `ckpt-*`, pelo MESMO
   * canal multiplexado (nenhuma conexão nova). `null` = consulta não confiável
   * (timeout/canal morto): o chamador PULA o tick, pois `null` jamais pode
   * significar "todos os canos morreram" — mesma disciplina do SMK-004.
   */
  async listPipeStates(profileId: string): Promise<Map<string, boolean> | null> {
    const output = await this.runQuery(
      profileId,
      `tmux list-panes -a -F '#{session_name} #{pane_pipe}'`,
    );
    if (output === null) return null;
    return parsePipeStates(output);
  }

  /**
   * Story 2.10/AC2 — re-arma o `pipe-pane` de UMA sessão via reset explícito.
   *
   * NUNCA usa `pipe-pane -o`: o `-o` serve para CRIAR de forma idempotente, mas
   * não vence o "pipe fantasma" pós-resurrect, que reporta `pane_pipe=1` com o
   * cano entupido e resiste ao `-o` (nota de campo 2026-07-17, confirmada em
   * 2026-07-27). A cura é fechar e reabrir, nesta ordem.
   *
   * O caminho do log é o MESMO da criação — divergir aqui criaria um segundo
   * arquivo e o watcher continuaria cego.
   */
  async rearmPipe(profileId: string, sessionName: string): Promise<void> {
    // Allowlist ANTES de qualquer construção de comando (AC3): não existe
    // caminho daqui que monte `pipe-pane` contra sessão não-ckpt.
    assertCkptSession(sessionName);
    const logPath = `${LOG_DIR}/${sessionName}.log`;
    await this.runQuery(
      profileId,
      `tmux pipe-pane -t ${shellQuote(sessionName)}; ` +
        `tmux pipe-pane -t ${shellQuote(sessionName)} ${shellQuote(`cat >> ${logPath}`)}`,
    );
  }

  /**
   * Captures the visible scrollback of a `ckpt-*` session's tmux pane (Story 1.5,
   * AC1/AC2/AC5/AC6). Runs `tmux capture-pane -e -p -S -500 -t <sessionName>` over a
   * SHORT-LIVED query channel on the SAME profile connection (via {@link runQuery} —
   * the exact delimiter strategy `listCkptSessions` uses), so reading history never
   * opens a connection of its own.
   *
   * The allowlist is enforced FIRST via {@link assertCkptSession}: there is no code
   * path here that can build a `capture-pane` command against a name without the
   * `ckpt-` prefix (AC5, AC6). A user's manual `4terminal.sh` / Tilix session can
   * never be captured.
   *
   * The flags are FIXED and NEVER omitted (AC2): `-e` preserves the ANSI colors
   * (the whole point of F3 — plain text would lose the terminal's visual context),
   * `-p` prints the pane to stdout, and `-S -500` starts the capture 500 lines back
   * (the visible history window). Returns the raw captured text (ANSI-escaped),
   * ready to be written verbatim into an xterm.
   */
  async capturePane(profileId: string, sessionName: string): Promise<string> {
    // Allowlist guard at command-construction time (AC5, AC6): refuse to target a
    // non-ckpt session BEFORE any command string is built.
    assertCkptSession(sessionName);
    // Same short-lived-channel + delimiter read strategy as listCkptSessions — no
    // new output-reading mechanism, no second connection (AC5).
    const output = await this.runQuery(
      profileId,
      `tmux capture-pane -e -p -S -500 -t ${shellQuote(sessionName)}`,
    );
    // Timeout → histórico vazio (best-effort): o tile drena o stream ao vivo
    // mesmo sem histórico; nunca trava (AC4 da 1.5).
    return output ?? '';
  }

  /**
   * Mata uma sessão tmux `ckpt-*` na VPS e remove seus metadados locais
   * (Story 1.7 — delete de sessão). Allowlist DURA em command-construction:
   * jamais constrói um kill-session contra nome sem o prefixo `ckpt-` (sessões
   * manuais do usuário intocadas — restrição #3 do epic). Usa o MESMO caminho
   * de query da 1.3 (canal curto na mesma conexão; nenhuma 2ª conexão SSH).
   */
  async killSession(profileId: string, sessionName: string): Promise<void> {
    assertCkptSession(sessionName);
    await this.runQuery(profileId, `tmux kill-session -t ${shellQuote(sessionName)}`);
    const row = this.metadata.getByProfileAndSessionName(Number(profileId), sessionName);
    if (row) this.metadata.delete(row.id);
  }

  /**
   * Adopts pre-existing `ckpt-*` sessions on connect (AC3). For each `ckpt-*`
   * session without local metadata, inserts a minimal cache row (projeto/agente
   * parsed best-effort from the name, or null). Heuristic, NOT source of truth.
   */
  async adoptExistingSessions(profileId: string): Promise<string[]> {
    const names = await this.listCkptSessions(profileId);
    if (names === null) return []; // consulta não confiável: não adota neste ciclo
    const adopted: string[] = [];
    for (const sessionName of names) {
      if (this.metadata.getByProfileAndSessionName(Number(profileId), sessionName)) continue; // already known ON THIS profile
      const parts = parseSessionName(sessionName);
      this.metadata.create({
        profileId: Number(profileId),
        project: parts?.projeto ?? null,
        // Story 2.12/AC4: `agent` NÃO vem mais do nome. Era exatamente daqui
        // que a mentira nascia — `ckpt-soria-claude-1` gravava agent='claude'
        // enquanto o pane rodava Codex. Sem fonte confiável na adoção, fica
        // null; o agente REAL é lido do processo no pane (query da 2.11).
        agent: null,
        agenda: parts?.assunto ?? null,
        sessionName,
        status: 'active',
      });
      adopted.push(sessionName);
      this.emit('sessionAdopted', { profileId, sessionName });
    }
    return adopted;
  }

  /**
   * Starts the periodic (~10s) reconciliation loop for a profile (AC6). Each tick
   * runs `tmux ls` and marks any locally-known `ckpt-*` session that is NO LONGER
   * listed as `error` (killed by OOM / manual kill). Uses only `tmux ls` — NO
   * `capture-pane` / screen reading (that is Story 1.5). Idempotent per profile.
   */
  startReconciliation(profileId: string): void {
    if (this.reconcileTimers.has(profileId)) return; // already running
    const tick = (): void => {
      // Chain the async reconcile, then re-arm the timer. Errors are swallowed so
      // a transient failure never crashes the loop or the process.
      // Story 2.10: liveness primeiro (o cache honesto é pré-condição do
      // re-arme), cura do cano depois. Um não bloqueia o agendamento do outro.
      void this.reconcileOnce(profileId)
        .then(() => this.rearmDeadPipes(profileId))
        .then(() => this.refreshHookCoverage(profileId))
        .catch(() => undefined)
        .finally(() => {
          if (this.reconcileTimers.has(profileId)) {
            const handle = this.scheduler(tick, this.reconcileIntervalMs);
            this.reconcileTimers.set(profileId, handle);
          }
        });
    };
    const handle = this.scheduler(tick, this.reconcileIntervalMs);
    this.reconcileTimers.set(profileId, handle);
  }

  /** Stops the reconciliation loop for a profile. */
  stopReconciliation(profileId: string): void {
    const handle = this.reconcileTimers.get(profileId);
    if (handle !== undefined) {
      this.cancelScheduler(handle);
      this.reconcileTimers.delete(profileId);
    }
  }

  /** Stops all reconciliation loops (shutdown). */
  stopAllReconciliation(): void {
    for (const profileId of [...this.reconcileTimers.keys()]) {
      this.stopReconciliation(profileId);
    }
  }

  /**
   * A single reconciliation pass (AC6). Public so tests can drive it deterministically
   * without a real timer. Compares live `tmux ls` against known `ckpt-*` metadata:
   * a known session that is no longer alive is marked `error` and `sessionError`
   * is emitted. A session that reappears is restored to `active`.
   */
  async reconcileOnce(profileId: string): Promise<void> {
    let live: Set<string>;
    try {
      const names = await this.listCkptSessions(profileId);
      // SMK-004: consulta não confiável (timeout/canal morto) NÃO significa que
      // as sessões sumiram — pular o tick em vez de marcar tudo como error.
      if (names === null) return;
      live = new Set(names);
    } catch {
      // A failed reconcile is a no-op for this tick; the loop keeps going.
      return;
    }

    const known = this.metadata.listByProfile(Number(profileId));
    for (const row of known) {
      if (!row.sessionName || !isCkptSession(row.sessionName)) continue;
      const alive = live.has(row.sessionName);
      if (!alive && row.status !== 'error') {
        this.metadata.update(row.id, { status: 'error' });
        this.emit('sessionError', { profileId, sessionName: row.sessionName });
      } else if (alive && row.status === 'error') {
        // Session came back (rare, but keep the cache honest).
        this.metadata.update(row.id, { status: 'active' });
      }
    }

  }

  /**
   * Story 2.10/AC2+AC4 — detecta cano morto e cura, com desistência.
   *
   * DELIBERADAMENTE SEPARADO de {@link reconcileOnce}: aquele trata de liveness
   * (a sessão existe?), este de saúde do espelhamento (o output está chegando
   * ao watcher?). Acoplar os dois faria uma query lenta/ausente do pipe atrasar
   * ou travar a reconciliação — que é a peça de que TUDO depende. O loop chama
   * os dois em sequência; cada um falha por conta própria.
   *
   * Público para que os testes o dirijam sem timer real, igual a `reconcileOnce`.
   */
  async rearmDeadPipes(profileId: string): Promise<void> {
    // Só sessões VIVAS conhecidas: re-armar sessão morta não faz sentido, e a
    // reconciliação imediatamente anterior já deixou o cache honesto.
    const live = new Set(
      this.metadata
        .listByProfile(Number(profileId))
        .filter((r) => r.status === 'active' && r.sessionName && isCkptSession(r.sessionName))
        .map((r) => r.sessionName as string),
    );
    if (live.size === 0) return;
    let pipes: Map<string, boolean> | null;
    try {
      pipes = await this.listPipeStates(profileId);
    } catch {
      return;
    }
    // Consulta não confiável NÃO é "todos os canos morreram" (AC1/SMK-004).
    if (pipes === null) return;

    for (const sessionName of live) {
      if (!isCkptSession(sessionName)) continue;
      const key = `${profileId} ${sessionName}`;
      const piped = pipes.get(sessionName);
      // Sessão fora do list-panes (corrida de criação/morte): não inventar.
      if (piped === undefined) continue;

      if (piped) {
        // Cano vivo: zera o contador para que uma sessão recuperada tenha
        // direito ao ciclo completo de tentativas se cair de novo.
        this.pipeRearmAttempts.delete(key);
        continue;
      }

      const attempts = this.pipeRearmAttempts.get(key) ?? 0;
      if (attempts >= this.maxPipeRearmAttempts) continue; // já desistiu

      const attempt = attempts + 1;
      this.pipeRearmAttempts.set(key, attempt);
      try {
        await this.rearmPipe(profileId, sessionName);
        this.emit('pipeRearmed', { profileId, sessionName, attempt });
      } catch {
        // Falha de comando conta como tentativa (já registrada acima).
      }
      if (attempt >= this.maxPipeRearmAttempts) {
        // O próximo tick confirmará: se `pipe=1`, o contador é zerado acima e
        // nada disso aconteceu de verdade. Só emitimos a desistência aqui.
        this.emit('pipeUnrecoverable', { profileId, sessionName });
      }
    }
  }

  /**
   * Story 2.11/AC2 — atualiza a cobertura de hooks do perfil.
   *
   * Compara, NO RELÓGIO DA VPS, o início do processo do agente de cada sessão
   * com o marcador `~/.cockpit/hooks-installed-at`. O Claude Code lê o
   * `settings.json` no START da sessão, então agente iniciado antes do marcador
   * roda sem hook — e, para agentes de TUI, a Camada 2 é estruturalmente cega
   * (nota de campo 2026-07-21). Só LÊ: a cura é reiniciar o agente, o que
   * destrói o contexto da conversa e é decisão do operador, nunca do cockpit.
   */
  async refreshHookCoverage(profileId: string): Promise<void> {
    // Uma linha por agente: `HOOK <kind> <mark|-> <installed:0|1>`, mais uma
    // linha por sessão: `<sessão> <epoch-de-início|-> <kind>`. `kind` é
    // `claude` / `codex` / `other` / `-` (sem agente), detectado pela cmdline
    // do processo — NUNCA pelo nome da sessão, que comprovadamente mente.
    const command =
      `CH=0; ` +
      `if grep -q 'ckpt-hook.sh user_prompt_submit claude-hook' ~/.claude/settings.json 2>/dev/null ` +
      `&& grep -q 'ckpt-hook.sh pre_tool_use claude-hook' ~/.claude/settings.json 2>/dev/null ` +
      `&& grep -q 'ckpt-hook.sh post_tool_use claude-hook' ~/.claude/settings.json 2>/dev/null ` +
      `&& grep -q 'ckpt-hook.sh notification claude-hook' ~/.claude/settings.json 2>/dev/null ` +
      `&& grep -q 'ckpt-hook.sh stop claude-hook' ~/.claude/settings.json 2>/dev/null; then CH=1; fi; ` +
      `CM=$(cat ~/.cockpit/hooks-installed-at.claude 2>/dev/null || cat ~/.cockpit/hooks-installed-at 2>/dev/null || echo -); ` +
      `DM=$(cat ~/.cockpit/hooks-installed-at.codex 2>/dev/null || echo -); ` +
      `DX=0; ` +
      // Codex exige trust interativo: `hooks.json` presente mas não confiado NÃO
      // executa nada. O trust vive em `~/.codex/config.toml`, seção `[hooks.state]`,
      // chaveado por `<arquivo>:<evento>:<i>:<j>` + `trusted_hash` do comando.
      // Sem essa segunda checagem o cockpit afirmaria cobertura que não existe.
      `if [ "$DM" != "-" ]; then ` +
      `DX=$(printf %s '${CODEX_HOOK_TRUST_PROBE_BASE64}' | base64 -d | node 2>/dev/null); ` +
      `[ "$DX" = "1" ] || DX=0; fi; ` +
      `echo "HOOK claude $CM $CH"; echo "HOOK codex $DM $DX"; ` +
      `tmux list-panes -a -F '#{session_name} #{pane_pid}' | while read S P; do ` +
      `C=$(pgrep -P $P | head -1); ` +
      `if [ -z "$C" ]; then echo "$S - -"; continue; fi; ` +
      `T=$(date -d "$(ps -o lstart= -p $C)" +%s 2>/dev/null || echo -); ` +
      `A=$(tr "\\0" " " < /proc/$C/cmdline 2>/dev/null); ` +
      `case "$A" in *codex*) K=codex;; *claude*) K=claude;; *) K=other;; esac; ` +
      `echo "$S $T $K"; done`;
    let output: string | null;
    try {
      output = await this.runQuery(profileId, command);
    } catch {
      return;
    }
    // Consulta não confiável não pode virar "ninguém tem hook" (SMK-004).
    if (output === null) return;
    const coverage = parseHookCoverage(output);
    this.hookless.set(profileId, new Set(coverage.noHooks));
    this.hooksUnsupported.set(profileId, new Set(coverage.unsupported));
  }

  /**
   * Story 2.11/AC3 — sessões do perfil cujo agente roda SEM hooks. Vazio
   * enquanto nada foi apurado: a UI não acusa o que não se sabe.
   */
  sessionsWithoutHooks(profileId: string): string[] {
    return [...(this.hookless.get(profileId) ?? [])];
  }

  /**
   * Story 2.12 — sessões cujo agente NÃO lê `~/.claude/settings.json`.
   * Reciclar não resolve: é limitação do agente (HOOKS.md §3), não do horário.
   */
  sessionsHooksUnsupported(profileId: string): string[] {
    return [...(this.hooksUnsupported.get(profileId) ?? [])];
  }

  /**
   * Story 2.10/AC5 — sessões cujo re-arme esgotou as tentativas, para a UI
   * acusar `no_pipe`. Escopado por perfil (a identidade é
   * `(profileId, sessionName)` — lição da Fase 1).
   */
  unrecoverablePipes(profileId: string): string[] {
    const prefix = `${profileId} `;
    const out: string[] = [];
    for (const [key, attempts] of this.pipeRearmAttempts) {
      if (attempts >= this.maxPipeRearmAttempts && key.startsWith(prefix)) {
        out.push(key.slice(prefix.length));
      }
    }
    return out;
  }

  /**
   * Story 2.6 (AC1): executa um comando de LEITURA na VPS pelo MESMO mecanismo
   * de canal de query do `tmux ls` (canal curto na conexão existente, pty:false,
   * delimitador, timeout ⇒ null — SMK-002/004/005 já absorvidos). É o canal de
   * controle que o poller do watcher usa para rodar `curl` contra o
   * 127.0.0.1 da PRÓPRIA VPS — a porta do watcher nunca atravessa a rede e
   * nenhuma conexão SSH nova é aberta por poll. Não introduz transporte novo:
   * delega ao runQuery privado.
   */
  async runHostQuery(profileId: string, cmd: string): Promise<string | null> {
    return this.runQuery(profileId, cmd);
  }

  /**
   * Runs a query command on a SHORT-LIVED channel and resolves its stdout, using
   * the delimiter strategy (ratified decision #1). Opens a channel via the
   * transport (no second connection), writes `<cmd>; echo '<DELIMITER>'`, buffers
   * `data` until the delimiter line arrives (or timeout), then closes the channel.
   */
  private runQuery(profileId: string, cmd: string): Promise<string | null> {
    // pty:false (SMK-005): canal de query sem PTY não ecoa o comando digitado —
    // o eco continha o próprio delimitador e encerrava a captura antes da
    // saída real do tmux chegar.
    const channelId = this.transport.openChannel(profileId, { pty: false });
    return new Promise<string | null>((resolve) => {
      let buffer = '';
      let settled = false;
      // A single-slot holder for the timeout handle. Using an object rather than
      // a reassigned `let` keeps the reference stable for `cleanup` while
      // satisfying prefer-const (the binding itself is never reassigned).
      const timerRef: { handle: unknown } = { handle: undefined };

      const cleanup = (): void => {
        this.transport.off('data', onData as (...a: unknown[]) => void);
        if (timerRef.handle !== undefined) this.cancelScheduler(timerRef.handle);
        this.transport.closeChannel(profileId, channelId, 'query complete');
      };

      const finish = (result: string | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onData = (p: { profileId: string; channelId: string; data: Buffer }): void => {
        if (p.channelId !== channelId) return; // only OUR query channel
        buffer += p.data.toString('utf8');
        // The delimiter is only meaningful as its OWN echoed line. Splitting on
        // the delimiter and taking the head slices off everything the command
        // printed up to (and not including) the delimiter — so a delimiter that
        // happens to appear INSIDE the payload before the echo boundary is still
        // captured as content, and the FIRST delimiter occurrence terminates.
        const idx = buffer.indexOf(QUERY_DELIMITER);
        if (idx !== -1) {
          finish(buffer.slice(0, idx));
        }
      };

      this.transport.on('data', onData);
      timerRef.handle = this.scheduler(() => {
        // Timeout SEM delimitador = consulta NÃO confiável (canal morto, rede
        // caída). Resolve null para o chamador distinguir de "saída vazia" —
        // antes, um timeout era tratado como lista vazia e a reconciliação
        // marcava sessões vivas como error (SMK-004 do smoke E2E).
        finish(null);
      }, this.queryTimeoutMs);

      // `; echo <DELIMITER>` guarantees a delimiter even if `cmd` fails (tmux ls
      // exits non-zero when no server is running — we still want a clean finish).
      this.transport.sendData(profileId, channelId, `${cmd}; echo '${QUERY_DELIMITER}'\n`);
    });
  }
}

/**
 * Parses `tmux ls -F '#{session_name}'` output into a list of `ckpt-*` session
 * names. Filters strictly via `isCkptSession` (AC4). Tolerant of the echoed
 * command line, prompts, empty lines, and CR — never throws.
 */
/**
 * Story 2.10/AC1 — parseia `tmux list-panes -a -F '#{session_name} #{pane_pipe}'`.
 *
 * Estritíssimo de propósito: o eco do próprio comando volta pelo PTY (contém
 * `#{session_name}`, espaços e chaves) e não pode ser confundido com dado. Só
 * passa linha com EXATAMENTE dois campos, nome `ckpt-` válido e flag `0`/`1`.
 *
 * Sessão com múltiplos panes (adotada fora do padrão 1 sessão = 1 pane) é
 * considerada COM cano vivo se QUALQUER pane estiver com `pipe=1` — não se
 * inventa semântica de multi-pane aqui (AC / risco declarado na story).
 */
export function parsePipeStates(output: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) continue;
    const [name, flag] = parts as [string, string];
    if (!isCkptSession(name)) continue;
    if (flag !== '0' && flag !== '1') continue;
    // OR entre panes da mesma sessão: um pane com pipe vivo basta.
    states.set(name, (states.get(name) ?? false) || flag === '1');
  }
  return states;
}

/** Resultado da apuração de cobertura de hooks por perfil (Story 2.12). */
export interface HookCoverage {
  /** Agente CONSOME esses hooks, mas iniciou antes deles: reciclar resolve. */
  noHooks: string[];
  /** Agente não lê `~/.claude/settings.json`: reciclar NÃO resolve. */
  unsupported: string[];
}

/**
 * Story 2.11/AC2 + Story 2.12 — parseia a query de cobertura de hooks.
 *
 * Formato (uma linha por item, gerado na VPS):
 *   `HOOK <kind> <epoch|-> <0|1>`     hook configurado + marcador por agente
 *   `<sessionName> <epoch|-> <kind>`  início do agente + qual agente é
 *
 * `kind` vem da **cmdline do processo**, nunca do nome da sessão — foi
 * justamente o nome ter mentido (`ckpt-soria-claude-1` rodando Codex) que
 * originou a Story 2.12.
 *
 * Separar os dois casos importa porque o conselho é oposto:
 *  - `noHooks` → reciclar a sessão ativa a detecção;
 *  - `unsupported` → reciclar não muda nada enquanto o hook daquele agente não
 *    estiver configurado na VPS.
 *
 * Story 2.13: o suporte deixa de ser uma constante do código. Ele deriva do
 * que a query encontrou instalado e confiável (`~/.claude/settings.json` para
 * Claude; `~/.codex/hooks.json` + marcador por agente para Codex). Ausência de
 * dado NUNCA vira alarme: se o hook existe mas o marcador está ausente, não
 * acusamos `noHooks`.
 */
export function parseHookCoverage(output: string): HookCoverage {
  const agents = new Map<string, { installed: boolean; mark: number | null }>();
  const rows: Array<{ name: string; started: number | null; kind: string }> = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'HOOK' && parts.length === 4) {
      const [, kind, rawMark, rawInstalled] = parts as [string, string, string, string];
      const parsed = Number(rawMark);
      agents.set(kind, {
        installed: rawInstalled === '1',
        mark: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
      });
      continue;
    }
    // Fallback compatível com o marcador global da 2.11/2.12. Ele representava
    // a instalação do Claude, então não é propagado para Codex.
    if (parts[0] === 'MARK' && parts.length === 2) {
      const parsed = Number(parts[1]);
      agents.set('claude', {
        installed: true,
        mark: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
      });
      continue;
    }
    if (parts.length !== 3) continue;
    const [name, rawStarted, kind] = parts as [string, string, string];
    if (!isCkptSession(name)) continue;
    if (kind === '-') continue; // shell puro: não há agente para ter hook
    const started = Number(rawStarted);
    rows.push({ name, started: Number.isFinite(started) && started > 0 ? started : null, kind });
  }

  const unsupported = rows
    .filter((r) => agents.get(r.kind)?.installed !== true)
    .map((r) => r.name);
  const noHooks = rows
    .filter((r) => {
      const agent = agents.get(r.kind);
      return agent?.installed === true && agent.mark !== null && r.started !== null && r.started < agent.mark;
    })
    .map((r) => r.name);
  return { noHooks, unsupported };
}

export function parseSessionList(output: string): string[] {
  const names: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (line.length === 0) continue;
    // A shell echo of our own command or a prompt might slip in; isCkptSession
    // rejects anything that is not a bare ckpt- name, and we further require the
    // whole trimmed line to be the session name (no embedded spaces).
    if (line.includes(' ')) continue;
    if (isCkptSession(line)) {
      names.push(line);
    }
  }
  return names;
}
