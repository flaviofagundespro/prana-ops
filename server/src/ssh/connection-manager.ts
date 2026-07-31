/**
 * ConnectionManager — the SSH transport layer (Story 1.2).
 *
 * INVARIANT (AC1, AC6, AC8): ONE ssh2 TCP connection per profile, multiplexed
 * into N independent shell channels. Six terminals for the same profile = one
 * connection, six channels. Requesting a channel for a profile that is already
 * connected (or connecting) NEVER opens a second `Client()`.
 *
 * EXCEÇÃO ÚNICA — saturação (Story 2.15): o `MaxSessions` do OpenSSH (default
 * **10**) limita canais POR CONEXÃO TCP. Ao bater o teto, `shell()` passa a ser
 * recusado, a conexão continua `ESTAB`, o `/health` responde e a sessão
 * simplesmente NÃO ABRE — sem erro, sem aviso. Foi uma manhã perdida em
 * 2026-07-29, com o agravante de que `ssh` manual do terminal funcionava (cada
 * `ssh` é uma conexão nova, com contador próprio).
 *
 * A partir desta story o profile tem um POOL: começa com uma conexão e ganha
 * outra SÓ quando o servidor recusa um canal. Enquanto ninguém satura nada, o
 * comportamento é byte a byte o de antes (`connectionCount()` = 1 por profile).
 * O teto NÃO é hardcoded: ele é APRENDIDO da recusa (quantos canais de fato
 * coexistiam), porque 10 é só o default e a Azure já roda 60.
 *
 * SECURITY: authentication is ALWAYS by private key
 * read from the profile's `keyPath` (chmod 600 expected on disk, not managed by
 * this app). The `ssh2` connect config NEVER contains a `password` — not under
 * any code path. There is no password field in the profile schema and there is
 * no password branch here.
 *
 * RESILIENCE (AC4, AC5, AC11): a dropped connection triggers a single serial
 * reconnect with exponential backoff (with a cap). On successful reconnect, all
 * channels that were open before the drop are reopened with the SAME channelIds
 * (the server owns channelId authority — see ws/protocol.ts). No SSH failure
 * (connection or channel) is allowed to crash the process: every async network
 * operation has an error handler, and errors are surfaced as events, never as
 * unhandled exceptions.
 *
 * SCOPE: this is the transport layer ONLY. There is NO tmux logic (Story 1.3)
 * and NO terminal grid / UI (Story 1.4) here. The channel opened here is a
 * generic SSH shell; Story 1.3 is what runs `tmux new-session ...` over it.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

const esmRequire = createRequire(import.meta.url);
import type { Profile } from '../db/profiles.js';
import type { ConnectionState } from '../ws/protocol.js';

/** Minimal read-only view of the profile store the manager needs. */
export interface ProfileProvider {
  get(id: number): Profile | null;
}

/**
 * Factory that produces a fresh ssh2 `Client`. Injected so tests can substitute
 * a mock without a real network. Defaults to the real `ssh2.Client`.
 */
export type SshClientFactory = () => Client;

/** Reads a private key from disk. Injected so tests avoid touching the filesystem. */
export type PrivateKeyReader = (keyPath: string) => Buffer;

export interface ConnectionManagerOptions {
  profiles: ProfileProvider;
  /** Defaults to the real ssh2 Client. */
  clientFactory?: SshClientFactory;
  /** Defaults to `fs.readFileSync`. */
  readPrivateKey?: PrivateKeyReader;
  /** ssh2 keepaliveInterval in ms (AC3). Default 10000 (10s). */
  keepaliveInterval?: number;
  /** Base backoff delay in ms (AC4). Default 1000 (1s → 2s → 4s → 8s ...). */
  backoffBaseMs?: number;
  /** Backoff ceiling in ms (AC4). Default 30000 (30s). Prevents unbounded growth. */
  backoffMaxMs?: number;
  /** Max reconnect attempts before giving up and emitting `error`. Default 10. */
  maxReconnectAttempts?: number;
  /** Injected scheduler for backoff timers (tests pass fake timers). Defaults to setTimeout. */
  scheduler?: (fn: () => void, ms: number) => void;
}

/** Events emitted by the manager. */
export interface ConnectionManagerEvents {
  /** Per-profile connection state change (AC11). */
  state: (payload: { profileId: string; state: ConnectionState }) => void;
  /** Channel produced output (stdout/stderr). */
  data: (payload: { profileId: string; channelId: string; data: Buffer }) => void;
  /** Channel closed (by user, remote, or error). */
  channelClose: (payload: { profileId: string; channelId: string; reason?: string }) => void;
  /**
   * Non-fatal error surfaced instead of throwing (AC5).
   *
   * NOTE: deliberately named `channelError`, NOT `error`. Node's EventEmitter
   * special-cases the `'error'` event: emitting it with no listener attached
   * throws and crashes the process — the exact opposite of AC5. A neutral event
   * name guarantees a missing listener is a harmless no-op.
   */
  channelError: (payload: { profileId: string; channelId?: string; message: string }) => void;
}

/**
 * Story 2.15/AC4 — canais de CONTROLE (`tmux ls`, `pipe-pane`, `send-keys`, o
 * poll do watcher) não podem consumir a cota que o operador precisa para abrir
 * JANELAS. Depois que o teto é conhecido, cada conexão passa a guardar estes
 * slots para controle: um canal de sessão não os toma.
 *
 * Dois é o mínimo honesto — o `runQuery` do tmuxManager abre um canal efêmero e
 * o poller do watcher outro, e eles se sobrepõem no tempo. Contabilização
 * separada (o que o AC4 permite) em vez de conexão dedicada: uma conexão a mais
 * só para controle violaria o AC7 (uma conexão até saturar).
 */
const CONTROL_RESERVE = 2;

/**
 * Quantas vezes um canal recusado é remanejado para outra conexão antes de
 * desistir. Um: se a segunda conexão também recusa, o problema não é `MaxSessions`
 * (é `MaxStartups`, rede, ou o servidor de fato no limite) e insistir viraria a
 * tempestade de reconexão que a Fase 1 evita por desenho.
 */
const MAX_CHANNEL_RELOCATIONS = 1;

/** Internal per-channel record. */
interface ChannelRecord {
  channelId: string;
  /** Live stream once open; null while (re)connecting. */
  stream: ClientChannel | null;
  /** Last known PTY size, replayed after a reconnect reopen. */
  cols: number;
  rows: number;
  /** False para canais de query (sem eco/prompt); true para terminais. */
  pty: boolean;
  /**
   * Comando de inicialização (ex.: attach do tmux) re-executado a cada
   * REABERTURA do canal pós-reconexão. Sem isso, o canal reaberto era um shell
   * pelado fora do tmux (SMK-010 do smoke E2E). A primeira execução vem do
   * sendData normal do chamador (via pendingWrites).
   */
  initCommand?: string;
  /** True após a primeira abertura do stream (distingue reopen de open). */
  everOpened: boolean;
  /**
   * Escritas feitas antes do stream abrir. Sem isso, o primeiro comando de um
   * canal de query é descartado silenciosamente (o shell abre async) — achado
   * SMK-002 do smoke E2E.
   */
  pendingWrites: string[];
  /**
   * Marcado por closeChannel. Se o shell abrir DEPOIS do close (corrida
   * close-before-open), o stream é encerrado na hora em vez de vazar um slot
   * de sessão no sshd (MaxSessions) — achado SMK-002 do smoke E2E.
   */
  closed: boolean;
  /** Story 2.15 — quantas vezes este canal já foi remanejado por recusa. */
  relocations: number;
}

/** Internal per-profile connection record. */
interface ProfileConnection {
  profileId: string;
  client: Client;
  state: ConnectionState;
  /** channelId → record. Never more than the caller opened; survives reconnects. */
  channels: Map<string, ChannelRecord>;
  reconnectAttempts: number;
  /** True while a reconnect timer is pending, to keep reconnect strictly serial. */
  reconnecting: boolean;
  /** True once the caller explicitly disconnected — suppresses reconnect. */
  disposed: boolean;
}

/**
 * Story 2.15/AC3 — o conjunto de conexões de UM profile. Nasce com uma só e
 * cresce apenas sob recusa de canal.
 */
interface ProfilePool {
  profileId: string;
  /** `[0]` é a conexão original. As demais existem porque o servidor recusou. */
  connections: ProfileConnection[];
  /**
   * Monotônico POR POOL (não por conexão): o `channelId` tem de ser único entre
   * todas as conexões do profile, senão dois canais em conexões diferentes
   * colidiriam no mesmo id e o roteamento entregaria dados no tile errado.
   */
  channelSeq: number;
  /**
   * Story 2.15/AC5 — teto APRENDIDO: quantos canais coexistiram de fato quando
   * uma recusa aconteceu. `undefined` = nunca saturou, e enquanto for
   * `undefined` a alocação é a de antes desta story (tudo na conexão [0]).
   * Nunca 10, nunca 60 — o número vem do servidor, não do código.
   */
  observedCeiling?: number;
}

const DEFAULT_KEEPALIVE_MS = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

/**
 * Typed EventEmitter wrapper. Keeps `on`/`emit` type-safe against
 * {@link ConnectionManagerEvents} while reusing Node's EventEmitter.
 */
export class ConnectionManager extends EventEmitter {
  private readonly profiles: ProfileProvider;
  private readonly clientFactory: SshClientFactory;
  private readonly readPrivateKey: PrivateKeyReader;
  private readonly keepaliveInterval: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly scheduler: (fn: () => void, ms: number) => void;

  /**
   * profileId → pool. Um pool por profile; UMA conexão por pool até que o
   * servidor recuse um canal (Story 2.15).
   */
  private readonly pools = new Map<string, ProfilePool>();

  constructor(options: ConnectionManagerOptions) {
    super();
    this.profiles = options.profiles;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.readPrivateKey = options.readPrivateKey ?? ((keyPath) => fs.readFileSync(keyPath));
    this.keepaliveInterval = options.keepaliveInterval ?? DEFAULT_KEEPALIVE_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.scheduler = options.scheduler ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  // Typed event overloads ---------------------------------------------------

  override on<E extends keyof ConnectionManagerEvents>(
    event: E,
    listener: ConnectionManagerEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof ConnectionManagerEvents>(
    event: E,
    ...args: Parameters<ConnectionManagerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Ensures a single connection exists for `profileId` and returns it. If the
   * profile is already connected or connecting, the existing `Client` is reused
   * — a second `Client()` is NEVER created for the same profile (AC1, AC6, AC8).
   */
  private ensureConnection(profileId: string): ProfileConnection {
    const pool = this.pools.get(profileId);
    const existing = pool?.connections.find((c) => !c.disposed);
    if (existing) {
      return existing;
    }
    return this.spawnConnection(profileId);
  }

  /**
   * Cria UMA conexão nova para o profile (e o pool, se ainda não existir). A
   * segunda em diante só nasce por {@link relocateRefusedChannel} — nunca por
   * conveniência, porque cada conexão é um handshake (~1,8s medido) e um
   * processo `sshd` a mais na VPS.
   */
  private spawnConnection(profileId: string): ProfileConnection {
    const profile = this.profiles.get(Number(profileId));
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const pool = this.pools.get(profileId) ?? { profileId, connections: [], channelSeq: 0 };
    this.pools.set(profileId, pool);

    const client = this.clientFactory();
    const conn: ProfileConnection = {
      profileId,
      client,
      state: 'connecting',
      channels: new Map(),
      reconnectAttempts: 0,
      reconnecting: false,
      disposed: false,
    };
    pool.connections.push(conn);

    this.wireClient(conn, profile);
    this.setState(conn, 'connecting');
    this.connect(conn, profile);
    return conn;
  }

  /** O pool do profile, criado sob demanda. */
  private poolOf(profileId: string): ProfilePool | undefined {
    return this.pools.get(profileId);
  }

  /** Localiza um canal em QUALQUER conexão do pool (o id é único no pool). */
  private findChannel(
    profileId: string,
    channelId: string,
  ): { conn: ProfileConnection; record: ChannelRecord } | undefined {
    const pool = this.pools.get(profileId);
    if (!pool) return undefined;
    for (const conn of pool.connections) {
      const record = conn.channels.get(channelId);
      if (record) return { conn, record };
    }
    return undefined;
  }

  /**
   * Story 2.15/AC3+AC4 — escolhe em qual conexão do pool o canal vai abrir.
   *
   * Enquanto o teto é desconhecido (`observedCeiling === undefined`), devolve
   * SEMPRE a conexão [0]: é o caminho de antes desta story, e é por isso que um
   * profile pequeno continua com uma conexão só (AC7).
   *
   * Conhecido o teto, canais de sessão respeitam a reserva de controle e canais
   * de controle podem usar o teto cheio. Sem lugar em nenhuma conexão, nasce
   * outra.
   */
  private pickConnection(profileId: string, isControl: boolean): ProfileConnection {
    const pool = this.poolOf(profileId);
    if (!pool || pool.connections.length === 0 || pool.observedCeiling === undefined) {
      return this.ensureConnection(profileId);
    }
    const budget = isControl
      ? pool.observedCeiling
      : Math.max(1, pool.observedCeiling - CONTROL_RESERVE);

    const room = pool.connections.find((c) => !c.disposed && c.channels.size < budget);
    if (room) return room;
    return this.spawnConnection(profileId);
  }

  /**
   * Story 2.15/AC1 — a recusa de canal por LIMITE é distinguida de outros erros.
   *
   * O OpenSSH responde `CHANNEL_OPEN_FAILURE` quando `MaxSessions` está estourado;
   * o `ssh2` entrega isso como erro com `reason` (`ADMINISTRATIVELY_PROHIBITED` /
   * `RESOURCE_SHORTAGE`) e mensagem `open failed`. Um erro de rede, uma chave
   * recusada ou um `UNKNOWN_CHANNEL_TYPE` NÃO entram aqui: tratar qualquer falha
   * como saturação faria o cockpit abrir conexões contra um servidor que está
   * recusando por outro motivo — exatamente o ruído que o AC1 proíbe.
   */
  private isChannelRefusal(err: Error): boolean {
    const reason = String((err as { reason?: unknown }).reason ?? '').toUpperCase();
    if (reason === 'ADMINISTRATIVELY_PROHIBITED' || reason === 'RESOURCE_SHORTAGE') return true;
    return /open failed|channel open failure|administratively prohibited/i.test(err.message);
  }

  /**
   * Story 2.15/AC3+AC5 — aprende o teto e remaneja o canal recusado para outra
   * conexão. Retorna `true` se assumiu a responsabilidade pelo canal.
   *
   * O teto aprendido é o número de canais que de fato COEXISTEM naquela conexão
   * (streams vivos), não o total de records: um record sem stream nunca ocupou
   * slot no servidor e contá-lo faria o cockpit subestimar o teto para sempre.
   */
  private relocateRefusedChannel(
    conn: ProfileConnection,
    record: ChannelRecord,
    err: Error,
  ): boolean {
    const pool = this.poolOf(conn.profileId);
    if (!pool || !this.isChannelRefusal(err)) return false;
    if (record.closed || conn.disposed) return false;
    if (record.relocations >= MAX_CHANNEL_RELOCATIONS) return false;

    const live = [...conn.channels.values()].filter((r) => r.stream !== null).length;
    // Sem NENHUM canal vivo, a recusa não é teto — é a conexão/servidor com
    // outro problema. Aprender "teto = 0" travaria o profile para sempre.
    if (live === 0) return false;

    const learned = pool.observedCeiling === undefined ? live : Math.min(pool.observedCeiling, live);
    const isFirstDiscovery = pool.observedCeiling === undefined;
    pool.observedCeiling = learned;

    conn.channels.delete(record.channelId);
    record.relocations += 1;

    const target = this.pickConnection(conn.profileId, !record.pty);
    if (target === conn) {
      // Nada mudou de lugar: não fingir que resolveu.
      conn.channels.set(record.channelId, record);
      return false;
    }
    target.channels.set(record.channelId, record);

    // AC2 — o operador precisa saber o que aconteceu e o que fazer. Texto, não
    // código de erro; sem cor nova (a paleta é dos estados do watcher).
    if (isFirstDiscovery) {
      this.emit('channelError', {
        profileId: conn.profileId,
        channelId: record.channelId,
        message:
          `o servidor recusou um canal novo nesta conexão SSH (limite de ~${learned} ` +
          `canais por conexão — MaxSessions do sshd). Abrindo uma conexão adicional ` +
          `para este perfil; a sessão deve subir em alguns segundos.`,
      });
    }

    if (target.state === 'connected') {
      this.openStream(target, record);
    }
    return true;
  }

  /** Attaches ssh2 event handlers. Registered once per Client instance. */
  private wireClient(conn: ProfileConnection, profile: Profile): void {
    const { client } = conn;

    client.on('ready', () => {
      conn.reconnectAttempts = 0;
      conn.reconnecting = false;
      this.setState(conn, 'connected');
      // Reopen any channels that existed before a drop, with SAME channelIds (AC4).
      for (const record of conn.channels.values()) {
        this.openStream(conn, record);
      }
    });

    // AC5: an error listener is MANDATORY on every client so a network error is
    // handled, never thrown as an uncaught exception that would crash the app.
    client.on('error', (err: Error) => {
      this.emit('channelError', { profileId: conn.profileId, message: err.message });
      this.scheduleReconnect(conn, profile);
    });

    client.on('close', () => {
      // Drop live stream handles; records are kept so they can be reopened.
      for (const record of conn.channels.values()) {
        record.stream = null;
      }
      if (!conn.disposed) {
        this.scheduleReconnect(conn, profile);
      }
    });
  }

  /** Builds the key-only connect config and initiates the TCP connection. */
  private connect(conn: ProfileConnection, profile: Profile): void {
    let privateKey: Buffer;
    try {
      privateKey = this.readPrivateKey(profile.keyPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('channelError', {
        profileId: conn.profileId,
        message: `failed to read private key at ${profile.keyPath}: ${message}`,
      });
      this.setState(conn, 'error');
      return;
    }

    // SECURITY: key-only. There is intentionally NO `password` key here (AC7).
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.user,
      privateKey,
      keepaliveInterval: this.keepaliveInterval,
    };

    try {
      conn.client.connect(config);
    } catch (err) {
      // Even synchronous throws from connect() must not escape (AC5).
      const message = err instanceof Error ? err.message : String(err);
      this.emit('channelError', { profileId: conn.profileId, message });
      this.scheduleReconnect(conn, profile);
    }
  }

  /**
   * Schedules a single serial reconnect with exponential backoff, capped at
   * `backoffMaxMs`. Concurrent reconnects for the same profile are prevented by
   * the `reconnecting` flag (AC4). Emits `error` and stops after
   * `maxReconnectAttempts`.
   */
  private scheduleReconnect(conn: ProfileConnection, profile: Profile): void {
    if (conn.disposed || conn.reconnecting) return;

    if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('channelError', {
        profileId: conn.profileId,
        message: `giving up after ${conn.reconnectAttempts} reconnect attempts`,
      });
      this.setState(conn, 'error');
      return;
    }

    conn.reconnecting = true;
    this.setState(conn, 'reconnecting');

    const delay = Math.min(
      this.backoffBaseMs * 2 ** conn.reconnectAttempts,
      this.backoffMaxMs,
    );
    conn.reconnectAttempts += 1;

    this.scheduler(() => {
      if (conn.disposed) return;
      conn.reconnecting = false;
      // Fresh Client for the reconnect: old one is closed/errored.
      conn.client = this.clientFactory();
      this.wireClient(conn, profile);
      this.connect(conn, profile);
    }, delay);
  }

  /**
   * Opens a new shell channel for `profileId`, reusing the profile's single
   * connection (AC2). The server mints the channelId (ratified contract). If the
   * connection is not yet ready, the channel is registered and opened once the
   * connection becomes ready (or reopened after a reconnect).
   *
   * @returns the server-minted channelId.
   */
  openChannel(profileId: string, opts?: { pty?: boolean; initCommand?: string }): string {
    // ARCH-001 (Story 1.3, AC8): if a connection already exists for this profile
    // and it is in a terminal-failure state (`error` = backoff exhausted, or
    // `closed` = explicitly torn down), do NOT register a channel whose stream
    // will never open and hand back a "dead" channelId that silently acks. Fail
    // loudly instead so the ws layer can surface `channel:error` to the client.
    //
    // NOTE: a brand-new profile (no entry yet) or one still `connecting` /
    // `reconnecting` is allowed through — the channel is registered and opened
    // once/if the connection becomes ready (existing 1.2 behavior). Only the
    // terminal states are rejected.
    // Story 2.15: com pool, "a conexão do profile está morta" só vale se TODAS
    // estiverem — uma conexão extra saudável é caminho legítimo para o canal.
    const preexistingPool = this.pools.get(profileId);
    const usable = preexistingPool?.connections.filter(
      (c) => !c.disposed && c.state !== 'error' && c.state !== 'closed',
    );
    if (preexistingPool && preexistingPool.connections.length > 0 && usable?.length === 0) {
      const worst = preexistingPool.connections[preexistingPool.connections.length - 1];
      throw new Error(
        `cannot open channel: profile ${profileId} connection is ${worst?.state} ` +
          `(backoff exhausted or connection closed) — not acking a dead channel`,
      );
    }

    const isControl = opts?.pty === false;
    const conn = this.pickConnection(profileId, isControl);
    const pool = this.poolOf(profileId);
    if (!pool) throw new Error(`Unknown profile: ${profileId}`);
    pool.channelSeq += 1;
    const channelId = `${profileId}:${pool.channelSeq}`;
    const record: ChannelRecord = {
      channelId,
      stream: null,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      pty: opts?.pty !== false,
      ...(opts?.initCommand !== undefined ? { initCommand: opts.initCommand } : {}),
      pendingWrites: [],
      closed: false,
      everOpened: false,
      relocations: 0,
    };
    conn.channels.set(channelId, record);

    if (conn.state === 'connected') {
      this.openStream(conn, record);
    }
    return channelId;
  }

  /** Requests the underlying ssh2 shell stream for a channel record. */
  private openStream(conn: ProfileConnection, record: ChannelRecord): void {
    // Canais de query (pty:false) abrem shell SEM PTY: sem eco do comando
    // digitado e sem prompt — a saída fica limpa para a estratégia de
    // delimitador do runQuery (achado SMK-002/SMK-005 do smoke E2E).
    conn.client.shell(
      record.pty ? { cols: record.cols, rows: record.rows, term: 'xterm-256color' } : false,
      (err, stream) => {
        if (err) {
          // Story 2.15/AC1+AC3 — recusa por LIMITE não é falha do canal: é o
          // teto da conexão. Antes desta story esse caminho terminava aqui, num
          // `channelError` que o front nem tratava: a sessão não abria e a tela
          // não dizia nada.
          if (this.relocateRefusedChannel(conn, record, err)) return;
          // AC5: a failed channel open is surfaced, never thrown.
          this.emit('channelError', {
            profileId: conn.profileId,
            channelId: record.channelId,
            message: `failed to open channel: ${err.message}`,
          });
          // MaxSessions bomb (SMK-002 recidiva): um `shell()` recusado pelo sshd
          // (`Channel open failure: open failed`) NÃO limpava o record. Canais de
          // query (pty:false) são efêmeros — se o open falha, o runQuery só
          // resolve por timeout e o record vira zumbi. Pior: ele sobrevive em
          // `conn.channels` e é RE-ABERTO a cada reconexão (loop `ready`),
          // multiplicando as tentativas de shell contra um servidor já saturado
          // e impedindo a recuperação. Removê-lo aqui corta o acúmulo na raiz.
          // Terminais (pty:true) representam uma sessão real do usuário e são em
          // número finito (o que o usuário abriu) — mantêm o record para retry
          // na próxima reconexão (AC4), sem crescimento autônomo.
          if (!record.pty && conn.channels.get(record.channelId) === record) {
            conn.channels.delete(record.channelId);
            this.emit('channelClose', {
              profileId: conn.profileId,
              channelId: record.channelId,
              reason: 'open failed',
            });
          }
          return;
        }
        // Corrida close-before-open: o canal foi fechado (ou a conexão
        // descartada) enquanto o shell abria. Encerra imediatamente para não
        // vazar um slot de sessão no sshd.
        if (record.closed || conn.disposed || conn.channels.get(record.channelId) !== record) {
          try {
            stream.end();
          } catch {
            // Nada a fazer: o objetivo é só não vazar.
          }
          return;
        }
        record.stream = stream;
        // SMK-012: o shell() foi requisitado com o tamanho que o record TINHA na
        // época; um channel:resize que chegou durante a abertura ficou só
        // armazenado. Reaplica o tamanho atual — sem isso o tmux attacha em
        // 80x24 e o conteúdo ocupa 1/4 do tile até o próximo resize manual.
        if (record.pty) {
          stream.setWindow(record.rows, record.cols, 0, 0);
        }
        // SMK-010: numa REABERTURA (reconexão), o shell é novo — re-executa o
        // comando de init (attach do tmux) antes de qualquer input pendente.
        if (record.everOpened && record.initCommand) {
          stream.write(record.initCommand);
        }
        record.everOpened = true;
        if (record.pendingWrites.length > 0) {
          for (const data of record.pendingWrites) stream.write(data);
          record.pendingWrites = [];
        }

        stream.on('data', (data: Buffer) => {
          this.emit('data', {
            profileId: conn.profileId,
            channelId: record.channelId,
            data,
          });
        });

        // stderr on a shell channel — forward as data too.
        stream.stderr.on('data', (data: Buffer) => {
          this.emit('data', {
            profileId: conn.profileId,
            channelId: record.channelId,
            data,
          });
        });

        stream.on('close', () => {
          // Only forget the channel if it wasn't dropped by a connection loss.
          // If the connection is down, keep the record so reconnect can reopen it.
          if (conn.channels.get(record.channelId)?.stream === stream) {
            record.stream = null;
          }
        });

        // AC5: per-stream error handler so a channel error can't crash the app.
        stream.on('error', (streamErr: Error) => {
          this.emit('channelError', {
            profileId: conn.profileId,
            channelId: record.channelId,
            message: `channel error: ${streamErr.message}`,
          });
        });
      },
    );
  }

  /** Writes input (stdin) to an open channel. No-op if the channel is not live. */
  sendData(profileId: string, channelId: string, data: string): void {
    const record = this.findChannel(profileId, channelId)?.record;
    if (!record) return;
    if (record.stream) {
      record.stream.write(data);
    } else {
      // Stream ainda abrindo (shell é async): enfileira e o openStream faz o
      // flush na abertura. Antes disso, o primeiro comando de todo canal de
      // query era descartado (SMK-002).
      record.pendingWrites.push(data);
    }
  }

  /**
   * Propagates a resize to the SSH channel via `stream.setWindow` (AC10,
   * window-change). Stores cols/rows so the size is replayed after a reconnect.
   */
  resizeChannel(profileId: string, channelId: string, cols: number, rows: number): void {
    const record = this.findChannel(profileId, channelId)?.record;
    if (!record) return;
    record.cols = cols;
    record.rows = rows;
    // setWindow(rows, cols, height, width). Pixel dims are 0 (unknown) — standard.
    record.stream?.setWindow(rows, cols, 0, 0);
  }

  /**
   * Closes a single channel (AC8) without affecting the connection or other
   * channels. The channel record is removed so a subsequent reconnect does NOT
   * reopen it.
   */
  closeChannel(profileId: string, channelId: string, reason?: string): void {
    const found = this.findChannel(profileId, channelId);
    if (!found) return;
    const { conn, record } = found;

    record.closed = true;
    conn.channels.delete(channelId);
    try {
      record.stream?.end();
    } catch (err) {
      // Closing a channel must never throw upstream (AC5).
      this.emit('channelError', {
        profileId,
        channelId,
        message: `error closing channel: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    this.emit('channelClose', { profileId, channelId, reason });
  }

  /**
   * Tears down a profile's connection and all its channels. Suppresses further
   * reconnects. Used on shutdown or when a profile is removed.
   */
  disconnect(profileId: string): void {
    const pool = this.pools.get(profileId);
    if (!pool) return;
    // Story 2.15: derruba TODAS as conexões do pool. Deixar uma para trás
    // manteria a máquina de reconexão viva para um profile excluído — o bug que
    // o SMK-003 corrigiu, agora multiplicado pelo pool.
    for (const conn of pool.connections) {
      conn.disposed = true;
      for (const channelId of [...conn.channels.keys()]) {
        this.closeChannel(profileId, channelId, 'disconnect');
      }
      try {
        conn.client.end();
      } catch {
        // Ignore: already closed/errored.
      }
      this.setState(conn, 'closed');
    }
    this.pools.delete(profileId);
  }

  /** Closes every connection. Used on server shutdown. */
  disconnectAll(): void {
    for (const profileId of [...this.pools.keys()]) {
      this.disconnect(profileId);
    }
  }

  /**
   * Número de conexões SSH vivas — somando o pool de cada profile. Os testes
   * usam isto para provar o invariante de UMA por profile enquanto ninguém
   * satura (AC7), e a conexão extra sob saturação (AC3).
   */
  connectionCount(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += pool.connections.length;
    return total;
  }

  /** Number of channels currently registered for a profile (todo o pool). */
  channelCount(profileId: string): number {
    const pool = this.pools.get(profileId);
    if (!pool) return 0;
    let total = 0;
    for (const conn of pool.connections) total += conn.channels.size;
    return total;
  }

  /**
   * Estado do profile. Com pool, o profile está `connected` se QUALQUER conexão
   * está — é a leitura que a UI precisa ("dá para trabalhar?"). Sem nenhuma
   * conectada, vale o estado da conexão original, que é quem carrega o backoff.
   */
  stateOf(profileId: string): ConnectionState | undefined {
    const pool = this.pools.get(profileId);
    if (!pool || pool.connections.length === 0) return undefined;
    if (pool.connections.some((c) => c.state === 'connected')) return 'connected';
    return pool.connections[0]?.state;
  }

  /**
   * Story 2.15/AC5 — teto de canais APRENDIDO para o profile (`undefined` = nunca
   * saturou). Exposto para diagnóstico e testes; nada no runtime decide por ele
   * além do próprio pool.
   */
  observedChannelCeiling(profileId: string): number | undefined {
    return this.pools.get(profileId)?.observedCeiling;
  }

  private setState(conn: ProfileConnection, state: ConnectionState): void {
    conn.state = state;
    this.emit('state', { profileId: conn.profileId, state });
  }
}

/** Default factory: the real ssh2 Client. Imported lazily to keep tests light. */
function defaultClientFactory(): Client {
  // Lazy load avoids importing ssh2 (and its crypto init) in pure-type contexts.
  // O servidor roda como ESM ("type": "module"), onde `require` não existe —
  // createRequire é a forma suportada de carregar um pacote CJS sob demanda.
  const { Client } = esmRequire('ssh2') as typeof import('ssh2');
  return new Client();
}
