/**
 * Internal WebSocket server.
 *
 * Story 1.1 established a minimal ping/pong transport. Story 1.2 extends it with
 * the typed channel protocol (see `protocol.ts`): the server routes
 * `channel:open` / `channel:data` / `channel:resize` / `channel:close` messages
 * to the {@link ConnectionManager}, which owns the single-SSH-connection-per-profile
 * invariant and the shell channels.
 *
 * SCOPE: transport + routing only. There is NO tmux logic (Story 1.3) and NO
 * terminal grid / UI (Story 1.4) here. The server mints channelIds (ratified
 * contract — see `protocol.ts`) and forwards raw shell I/O.
 */
import type { Server as HttpServer } from 'node:http';
import { PORT } from '../config.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ProfileChannelTransport } from '../transport/profile-connection-manager.js';
import type { TmuxSessionManager } from '../tmux/session-manager.js';
import type { WatcherSnapshot } from '../watcher/poller.js';
import type { RespondOutcome } from '../watcher/responder.js';
import {
  parseClientMessage,
  type ServerToClientMessage,
} from './protocol.js';

/**
 * Superfície mínima do WatcherPoller que o ws consome (Story 2.6) — interface
 * própria (não a classe concreta) para os testes usarem um fake leve, mesmo
 * padrão do ChannelTransport da 1.3.
 */
export interface WatcherSyncSource {
  on(event: 'snapshot', listener: (snapshot: WatcherSnapshot) => void): unknown;
  off(event: 'snapshot', listener: (...args: unknown[]) => void): unknown;
  lastSnapshots(): WatcherSnapshot[];
  patchDecision(
    profileId: string,
    decisionId: number,
    action: 'seen' | 'dismissed',
  ): Promise<boolean>;
}

/**
 * Superfície do DecisionResponder que o ws consome (Story 2.7) — interface
 * própria para os testes usarem um fake leve, mesmo padrão do WatcherSyncSource.
 */
export interface RespondHandler {
  respond(input: {
    profileId: string;
    decisionId: number;
    sessionName: string;
    text: string;
    confirmToken?: string;
  }): Promise<RespondOutcome>;
}

export interface AttachWebSocketOptions {
  server: HttpServer;
  path: string;
  /**
   * Port the browser is expected to have loaded the SPA from, used to validate
   * the `Origin` header on upgrade. Defaults to the configured HTTP port;
   * overridable so tests can run on an ephemeral port.
   */
  originPort?: number;
  /**
   * Optional SSH connection manager. When provided, channel:* messages are
   * routed to it. When omitted (e.g. the 1.1 smoke test), only ping/pong works.
   */
  connectionManager?: ProfileChannelTransport;
  /**
   * Optional tmux session manager (Story 1.3). When provided, `session:*`
   * messages (create-or-attach, list) are routed to it. This is a layer ABOVE
   * the ratified `channel:*` contract — it does not replace it.
   */
  tmuxManager?: TmuxSessionManager;
  /**
   * Timeout (ms) for a `profile:test-connection` on a not-yet-connected profile
   * (Story 1.6, Task 5). If the fresh connection does not reach `connected`
   * within this window, the test resolves `ok: false`. Default 8000 (8s).
   */
  testConnectionTimeoutMs?: number;
  /**
   * Optional watcher poller (Story 2.6). When provided, cada snapshot vira
   * `decisions:update` + `sessions:state` para TODOS os sockets (a fila é
   * app-level e agregada multi-VPS — não há canal para escopar; o escopo
   * ARCH-002 continua valendo para o tráfego channel:*), e `decisions:action`
   * é roteada como PATCH no watcher da VPS. Sem ele, o servidor se comporta
   * EXATAMENTE como na Fase 1 (aditivo).
   */
  watcherPoller?: WatcherSyncSource;
  /**
   * Optional decision responder (Story 2.7). Quando presente, `decisions:respond`
   * é roteada para ele (allowlist + gate high + escaping vivem LÁ, no server —
   * a UI é conveniência). Sem ele, respostas viram decisions:respond:result
   * ok:false — aditivo, nada quebra.
   */
  decisionResponder?: RespondHandler;
  /**
   * Story 2.10/AC5 — sessões com re-arme de pipe esgotado, por perfil. Vem do
   * TmuxSessionManager (conhecimento de tmux, não do watcher), e viaja junto do
   * `sessions:state` para não criar uma mensagem/round-trip só para isto.
   */
  unrecoverablePipes?: (profileId: string) => string[];
  /** Story 2.11/AC3 — sessões com agente sem hooks, por perfil. */
  sessionsWithoutHooks?: (profileId: string) => string[];
  /** Story 2.12 — sessões cujo agente não lê esses hooks. */
  sessionsHooksUnsupported?: (profileId: string) => string[];
}

/** Converte um snapshot do poller nas 2 mensagens aditivas do contrato (AC8). */
function snapshotMessages(
  snapshot: WatcherSnapshot,
  unrecoverablePipes?: (profileId: string) => string[],
  sessionsWithoutHooks?: (profileId: string) => string[],
  sessionsHooksUnsupported?: (profileId: string) => string[],
): ServerToClientMessage[] {
  return [
    {
      type: 'decisions:update',
      profileId: snapshot.profileId,
      watcherAvailable: snapshot.watcherAvailable,
      decisions: snapshot.decisions,
    },
    {
      type: 'sessions:state',
      profileId: snapshot.profileId,
      watcherAvailable: snapshot.watcherAvailable,
      states: snapshot.states,
      ...(unrecoverablePipes ? { unrecoverablePipes: unrecoverablePipes(snapshot.profileId) } : {}),
      ...(sessionsWithoutHooks
        ? { sessionsWithoutHooks: sessionsWithoutHooks(snapshot.profileId) }
        : {}),
      ...(sessionsHooksUnsupported
        ? { sessionsHooksUnsupported: sessionsHooksUnsupported(snapshot.profileId) }
        : {}),
    },
  ];
}

function send(socket: WebSocket, message: ServerToClientMessage | { type: string; [k: string]: unknown }): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/**
 * Attaches a WebSocketServer to an HTTP server. Returns the server instance so
 * the caller can close it on shutdown.
 */
const DEFAULT_TEST_CONNECTION_TIMEOUT_MS = 8_000;

/**
 * Origins allowed to open a WebSocket against the cockpit (2026-07-30).
 *
 * Binding to loopback keeps other MACHINES out. It does not keep other SOFTWARE
 * on this machine out, and the browser is software on this machine that runs
 * third-party code continuously. Crucially, **WebSocket is exempt from the
 * same-origin policy**: there is no preflight, and a page on any site can open
 * `ws://127.0.0.1:4000/ws` and both send and read messages. Only the server can
 * refuse it, by inspecting `Origin`.
 *
 * Without this check, visiting a page while the cockpit runs was enough for that
 * page to list sessions, read 500 lines of scrollback (`capture-pane`) and type
 * into live agent sessions.
 *
 * A request with NO `Origin` header is allowed: non-browser clients (the test
 * suite, `wscat`, a future CLI) do not send one, and they are not the threat —
 * the threat is specifically a browser acting on behalf of a foreign page.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === '') return true;
  // The Vite dev server (`npm run dev --workspace web`) proxies /ws, and the
  // browser's Origin is the dev server's, not ours. Allowed deliberately: an
  // attacker able to serve from loopback:5173 already runs code on this machine,
  // which is a strictly worse position than this check defends against.
  for (const p of [port, VITE_DEV_PORT]) {
    if (
      origin === `http://localhost:${p}` ||
      origin === `http://127.0.0.1:${p}` ||
      origin === `http://[::1]:${p}`
    ) {
      return true;
    }
  }
  return false;
}

/** Port of the Vite dev server (`web/vite.config.ts`). */
const VITE_DEV_PORT = 5173;

export function attachWebSocketServer({
  server,
  path,
  connectionManager,
  tmuxManager,
  testConnectionTimeoutMs = DEFAULT_TEST_CONNECTION_TIMEOUT_MS,
  watcherPoller,
  decisionResponder,
  unrecoverablePipes,
  sessionsWithoutHooks,
  sessionsHooksUnsupported,
  originPort = PORT,
}: AttachWebSocketOptions): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path,
    // Rejected BEFORE the connection exists — a refused page never gets to send
    // a single protocol message. `ws` answers 401 and drops the socket.
    verifyClient: ({ origin }: { origin?: string }) => {
      if (isAllowedOrigin(origin, originPort)) return true;
      console.warn(`[ws] refused websocket upgrade from origin ${JSON.stringify(origin)}`);
      return false;
    },
  });

  wss.on('connection', (socket: WebSocket) => {
    send(socket, { type: 'welcome', message: 'Prana OPS ws ready' });

    // Story 2.6: um socket recém-conectado recebe IMEDIATAMENTE o último
    // snapshot conhecido de cada perfil (badge/estados sem esperar o próximo
    // poll), e depois cada snapshot novo do poller.
    const onSnapshot = (snapshot: WatcherSnapshot): void => {
      for (const message of snapshotMessages(
        snapshot,
        unrecoverablePipes,
        sessionsWithoutHooks,
        sessionsHooksUnsupported,
      ))
        send(socket, message);
    };
    if (watcherPoller) {
      for (const snapshot of watcherPoller.lastSnapshots()) onSnapshot(snapshot);
      watcherPoller.on('snapshot', onSnapshot);
    }

    // Track channels opened by THIS socket so we can forward the right traffic
    // and clean up on disconnect. Maps channelId → profileId.
    const socketChannels = new Map<string, string>();

    /**
     * Returns true if this socket currently owns at least one channel on the
     * given profile. Derived on demand from `socketChannels.values()` (the Map
     * values ARE the profileIds) — no parallel Set to keep in sync. This is the
     * scoping predicate for ARCH-002: profile-scoped events (`channel:state` /
     * `channel:error`) are only forwarded to sockets that actually have a channel
     * on the event's profile.
     */
    const ownsProfile = (profileId: string): boolean => {
      for (const owned of socketChannels.values()) {
        if (owned === profileId) return true;
      }
      return false;
    };

    // Bridge ConnectionManager events to this socket. `channel:data` /
    // `channel:close` are filtered by channelId (only this socket's channels);
    // `channel:state` / `channel:error` are filtered by profileId (ARCH-002) so
    // a socket NEVER receives state/error for a profile it opened no channel on.
    const onData = (payload: { profileId: string; channelId: string; data: Buffer }): void => {
      if (socketChannels.has(payload.channelId)) {
        send(socket, {
          type: 'channel:data',
          channelId: payload.channelId,
          data: payload.data.toString('utf8'),
        });
      }
    };
    const onState = (payload: { profileId: string; state: string }): void => {
      // ARCH-002: only forward state for profiles this socket owns a channel on.
      if (!ownsProfile(payload.profileId)) return;
      send(socket, { type: 'channel:state', profileId: payload.profileId, state: payload.state });
    };
    const onChannelClose = (payload: {
      profileId: string;
      channelId: string;
      reason?: string;
    }): void => {
      if (socketChannels.has(payload.channelId)) {
        socketChannels.delete(payload.channelId);
        send(socket, {
          type: 'channel:close',
          channelId: payload.channelId,
          ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        });
      }
    };
    const onError = (payload: {
      profileId?: string;
      channelId?: string;
      message: string;
    }): void => {
      // ARCH-002: scope errors to this socket. Forward only if the socket owns
      // the errored channel (by channelId) OR owns a channel on the errored
      // profile (by profileId). A scopeless error (neither field) is dropped for
      // this socket — it cannot be attributed to a channel/profile it owns.
      const ownsChannel = payload.channelId !== undefined && socketChannels.has(payload.channelId);
      const ownsErrProfile = payload.profileId !== undefined && ownsProfile(payload.profileId);
      if (!ownsChannel && !ownsErrProfile) return;
      send(socket, {
        type: 'channel:error',
        ...(payload.profileId !== undefined ? { profileId: payload.profileId } : {}),
        ...(payload.channelId !== undefined ? { channelId: payload.channelId } : {}),
        message: payload.message,
      });
    };

    if (connectionManager) {
      connectionManager.on('data', onData);
      connectionManager.on('state', onState);
      connectionManager.on('channelClose', onChannelClose);
      connectionManager.on('channelError', onError);
    }

    socket.on('message', (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', message: 'invalid JSON' });
        return;
      }

      // Legacy ping/pong from Story 1.1 (kept for the transport smoke test).
      if (
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { type?: unknown }).type === 'ping'
      ) {
        send(socket, { type: 'pong' });
        return;
      }

      const message = parseClientMessage(payload);
      if (!message) {
        send(socket, { type: 'error', message: 'unknown or malformed message' });
        return;
      }

      // Story 2.6 (AC5): decisions:action NÃO depende do transporte SSH deste
      // socket (o canal usado é o do poller) — roteada ANTES do guard de
      // connectionManager. Vista/descartada → PATCH no watcher da VPS. O parse
      // já validou decisionId (inteiro positivo) e action (allowlist); o
      // poller revalida (defesa em profundidade). Nunca lança — falha vira
      // decisions:error; sucesso chega como decisions:update do re-poll.
      if (message.type === 'decisions:action') {
        const { profileId, decisionId, action } = message;
        if (!watcherPoller) {
          send(socket, {
            type: 'decisions:error',
            profileId,
            decisionId,
            message: 'watcher sync unavailable',
          });
          return;
        }
        void watcherPoller
          .patchDecision(profileId, decisionId, action)
          .then((ok) => {
            if (!ok) {
              send(socket, {
                type: 'decisions:error',
                profileId,
                decisionId,
                message: `failed to apply '${action}'`,
              });
            }
          })
          .catch((err: unknown) => {
            send(socket, {
              type: 'decisions:error',
              profileId,
              decisionId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }

      // Story 2.7 (AC1/AC4/AC7): resposta de decisão — como a decisions:action,
      // não depende do transporte SSH deste socket (o canal é do responder).
      // O responder nunca lança: challenge (high) ou result (ok/falha honesta).
      if (message.type === 'decisions:respond') {
        const { profileId, decisionId, sessionName } = message;
        if (!decisionResponder) {
          send(socket, {
            type: 'decisions:respond:result',
            profileId,
            decisionId,
            ok: false,
            message: 'respond unavailable',
          });
          return;
        }
        void decisionResponder
          .respond(message)
          .then((outcome) => {
            if (outcome.kind === 'challenge') {
              send(socket, {
                type: 'decisions:respond:challenge',
                profileId,
                decisionId,
                sessionName,
                command: outcome.command,
                confirmToken: outcome.confirmToken,
              });
            } else {
              send(socket, {
                type: 'decisions:respond:result',
                profileId,
                decisionId,
                ok: outcome.ok,
                ...(outcome.message !== undefined ? { message: outcome.message } : {}),
              });
            }
          })
          .catch((err: unknown) => {
            send(socket, {
              type: 'decisions:respond:result',
              profileId,
              decisionId,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }

      if (!connectionManager) {
        send(socket, { type: 'error', message: 'ssh transport unavailable' });
        return;
      }

      switch (message.type) {
        case 'channel:open': {
          try {
            const channelId = connectionManager.openChannel(message.profileId);
            socketChannels.set(channelId, message.profileId);
            // Server-minted channelId ack (ratified contract).
            send(socket, {
              type: 'channel:open',
              profileId: message.profileId,
              channelId,
            });
          } catch (err) {
            send(socket, {
              type: 'channel:error',
              profileId: message.profileId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case 'channel:data': {
          const profileId = socketChannels.get(message.channelId);
          if (profileId) {
            connectionManager.sendData(profileId, message.channelId, message.data);
          }
          break;
        }
        case 'channel:resize': {
          const profileId = socketChannels.get(message.channelId);
          if (profileId) {
            connectionManager.resizeChannel(
              profileId,
              message.channelId,
              message.cols,
              message.rows,
            );
          }
          break;
        }
        case 'channel:close': {
          const profileId = socketChannels.get(message.channelId);
          if (profileId) {
            socketChannels.delete(message.channelId);
            connectionManager.closeChannel(profileId, message.channelId, message.reason);
          }
          break;
        }
        case 'session:create': {
          // Story 1.3 (AC1): create-or-attach a ckpt-* tmux session. Layer above
          // the channel:* contract. The tmux manager mints the sessionName and
          // (via ConnectionManager.openChannel) the channelId.
          if (!tmuxManager) {
            send(socket, { type: 'session:error', profileId: message.profileId, message: 'tmux manager unavailable' });
            break;
          }
          try {
            const n = message.n ?? tmuxManager.nextSessionIndex(message.profileId, message.projeto, message.pauta);
            const { sessionName, channelId, project, label } = tmuxManager.createOrAttach(
              message.profileId,
              message.projeto,
              message.agente,
              n,
              { agenda: message.pauta },
            );
            // Track the channel so this socket receives the session's terminal I/O.
            socketChannels.set(channelId, message.profileId);
            send(socket, {
              type: 'session:created',
              profileId: message.profileId,
              sessionName,
              channelId,
              project,
              label,
            });
          } catch (err) {
            send(socket, {
              type: 'session:error',
              profileId: message.profileId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case 'session:list': {
          // Story 1.3 (AC3): list known ckpt-* sessions on the profile.
          if (!tmuxManager) {
            send(socket, { type: 'session:error', profileId: message.profileId, message: 'tmux manager unavailable' });
            break;
          }
          void tmuxManager
            .listCkptSessions(message.profileId)
            .then((sessions) => {
              send(socket, { type: 'session:list', profileId: message.profileId, sessions });
            })
            .catch((err: unknown) => {
              send(socket, {
                type: 'session:error',
                profileId: message.profileId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
        case 'history:request': {
          // Story 1.5 (AC1, AC4, AC5): capture the tile's tmux scrollback and reply
          // history:result (or history:error — never crash the process).
          if (!tmuxManager) {
            send(socket, { type: 'history:error', channelId: message.channelId, message: 'tmux manager unavailable' });
            break;
          }
          // ARCH-002 scoping (AC5): reject a history:request for a channelId this
          // socket does not own — a socket cannot capture history for a channel it
          // never opened. Same predicate used by channel:data/channel:resize.
          //
          // MNT-001 (Story 1.6, AC8): derive the profileId from the channel this
          // socket OWNS (`socketChannels.get`), NOT from the client-supplied
          // `message.profileId` — the same discipline channel:data/channel:resize
          // already use. The client's profileId is never trusted for the capture.
          const owned = socketChannels.get(message.channelId);
          if (owned === undefined) {
            send(socket, {
              type: 'history:error',
              channelId: message.channelId,
              message: 'unknown channel for this socket',
            });
            break;
          }
          void tmuxManager
            .capturePane(owned, message.sessionName)
            .then((data) => {
              send(socket, { type: 'history:result', channelId: message.channelId, data });
            })
            .catch((err: unknown) => {
              send(socket, {
                type: 'history:error',
                channelId: message.channelId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
        case 'profile:test-connection': {
          // Validate reachability WITHOUT opening a second persistent connection
          // for an already-connected profile — testing a profile must never disturb
          // the sessions running on it. Handler NEVER throws — a network failure
          // becomes ok:false, it never crashes the process.
          const { profileId } = message;
          try {
            if (connectionManager.stateOf(profileId) === 'connected') {
              // Already connected: reachability is already proven. No new channel.
              send(socket, { type: 'profile:test-connection:result', profileId, ok: true });
              break;
            }

            // Not connected: open the profile's SINGLE connection (via a channel),
            // wait for it to reach `connected` (or `error`/timeout), then close
            // ONLY the ephemeral test channel — the connection stays warm.
            //
            // openChannel creates the profile's single connection if needed (the
            // SAME connection real sessions would use — not a throwaway second one).
            // We open it FIRST so the channelId is captured before any listener can
            // fire and try to close it.
            const testChannelId = connectionManager.openChannel(profileId);
            let settled = false;

            const finish = (ok: boolean, msg?: string): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              connectionManager.off('state', onTestState as (...a: unknown[]) => void);
              connectionManager.closeChannel(profileId, testChannelId, 'test-connection done');
              send(socket, {
                type: 'profile:test-connection:result',
                profileId,
                ok,
                ...(msg !== undefined ? { message: msg } : {}),
              });
            };

            const onTestState = (payload: { profileId: string; state: string }): void => {
              if (payload.profileId !== profileId) return;
              if (payload.state === 'connected') finish(true);
              else if (payload.state === 'error' || payload.state === 'closed') {
                finish(false, `connection ${payload.state}`);
              }
            };

            const timer = setTimeout(
              () => finish(false, `connection test timed out after ${testConnectionTimeoutMs}ms`),
              testConnectionTimeoutMs,
            );

            connectionManager.on('state', onTestState);
            // Guard the (unlikely) synchronous-connected race: if the profile was
            // already connected between stateOf() and openChannel(), no further
            // `state` event fires, so settle now.
            if (connectionManager.stateOf(profileId) === 'connected') finish(true);
          } catch (err) {
            send(socket, {
              type: 'profile:test-connection:result',
              profileId,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      // Detach event bridges to avoid leaks across reconnecting clients.
      if (watcherPoller) {
        watcherPoller.off('snapshot', onSnapshot as (...a: unknown[]) => void);
      }
      if (connectionManager) {
        connectionManager.off('data', onData as (...a: unknown[]) => void);
        connectionManager.off('state', onState as (...a: unknown[]) => void);
        connectionManager.off('channelClose', onChannelClose as (...a: unknown[]) => void);
        connectionManager.off('channelError', onError as (...a: unknown[]) => void);
      }
      // Close this socket's channels so the remote shells don't linger.
      if (connectionManager) {
        for (const [channelId, profileId] of socketChannels) {
          connectionManager.closeChannel(profileId, channelId, 'socket closed');
        }
      }
      socketChannels.clear();
    });
  });

  return wss;
}
