/**
 * Typed WebSocket message envelope shared between backend and frontend (AC9, AC10).
 *
 * This is the transport contract for SSH shell channels. It is deliberately the
 * MINIMAL surface needed by Stories 1.3 (tmux) and 1.4 (terminal grid) so those
 * stories can consume it without rework — as recommended by the Story 1.1 QA gate
 * ("formalize a typed ws message envelope now: channel open/data/resize/close").
 *
 * RATIFIED CONTRACT (@po, 2026-07-12 — Story 1.2 validation, binding):
 *
 *  1. `channelId` authority is the SERVER. The client sends `channel:open` with a
 *     `profileId` ONLY; the server mints the `channelId` (it owns the
 *     ConnectionManager Map and the channel lifecycle — AC8) and replies with an
 *     open-ack carrying the `channelId`. Client-minted IDs risk collision across
 *     reconnects, and AC4 requires reopening the SAME channelIds after a drop —
 *     only guaranteeable if the server owns the ID.
 *
 *  2. `channel:close` carries an OPTIONAL reason. Shape: `{ channelId, code?, reason? }`.
 *     AC5/AC11 require propagating connection/channel errors without crashing the
 *     process; 1.4/1.5 must distinguish a user-initiated close from an error close
 *     to render the "reconnecting" state. Optional fields preserve the minimal shape.
 *
 * These field names are a design choice, not a requirement: the product spec asks
 * for resize/window-change and a terminal grid, and leaves the wire format open.
 *
 * NOTE: This module is intentionally free of runtime/Node dependencies so it can be
 * imported by the frontend (`web/`) as a pure type contract. See Completion Notes
 * in the story for the chosen sharing mechanism.
 */

/** Discriminant literals for the channel protocol. Exported for reuse in guards/switches. */
export const CHANNEL_MESSAGE_TYPES = [
  'channel:open',
  'channel:data',
  'channel:resize',
  'channel:close',
  'channel:state',
  'channel:error',
] as const;

export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

/**
 * Client requests a new shell channel on the given profile's SSH connection.
 * The client does NOT choose the channelId — the server mints it and replies
 * with a `channel:open` ack (see {@link ChannelOpenAck}).
 */
export interface ChannelOpenRequest {
  type: 'channel:open';
  profileId: string;
}

/** Client sends terminal input (stdin) to an open channel. */
export interface ChannelDataClientMessage {
  type: 'channel:data';
  channelId: string;
  data: string;
}

/** Client asks the server to resize the PTY of an open channel (window-change). */
export interface ChannelResizeMessage {
  type: 'channel:resize';
  channelId: string;
  cols: number;
  rows: number;
}

/**
 * Client requests closing a channel. `code`/`reason` are optional and, when sent
 * by the client, indicate a user-initiated close.
 */
export interface ChannelCloseMessage {
  type: 'channel:close';
  channelId: string;
  code?: number;
  reason?: string;
}

/**
 * Client asks the server to create-or-attach a tmux `ckpt-*` session (Story 1.3,
 * AC1). This is a message layer ABOVE the ratified `channel:*` contract — it does
 * NOT replace it (see the story Dev Notes). The server mints both the tmux
 * `sessionName` and the `channelId` and replies with {@link SessionCreatedAck}.
 *
 * RATIFIED (@po 2026-07-12, binding): fields are camelCase; the client supplies
 * `profileId`, `projeto`, `pauta`, `agente`; the server owns `sessionName` +
 * `channelId` minting.
 */
export interface SessionCreateRequest {
  type: 'session:create';
  profileId: string;
  projeto: string;
  pauta: string;
  agente: string;
  /** Optional session index (defaults server-side to a fresh value). */
  n?: number;
}

/** Client asks for the list of known `ckpt-*` sessions on a profile (AC3). */
export interface SessionListRequest {
  type: 'session:list';
  profileId: string;
}

/**
 * Client requests the visible scrollback history of a tile's tmux session (Story
 * 1.5, AC1/AC4/AC5). The server runs `tmux capture-pane -e -p -S -500` over the
 * SAME profile connection and replies with {@link HistoryResult} (or
 * {@link HistoryErrorMessage}). This is an ADDITIVE layer above the ratified
 * `channel:*` / `session:*` contracts — it does NOT replace them.
 *
 * RATIFIED (@po 2026-07-13, binding): fields are camelCase; `channelId` is the
 * correlation key (the tile filters the reply by its own `channelId`); the client
 * supplies `profileId` (which connection) and `sessionName` (which tmux pane).
 */
export interface HistoryRequest {
  type: 'history:request';
  profileId: string;
  channelId: string;
  sessionName: string;
}

/**
 * Client asks the server to TEST reachability of a profile's SSH connection
 * (Story 1.6, AC3). This is an ADDITIVE layer above the ratified `channel:*` /
 * `session:*` / `history:*` contracts — it does NOT replace them. The server
 * NEVER opens a second persistent connection for an already-connected profile:
 * if the profile is `connected` the test is trivially `ok`; otherwise it opens
 * the profile's SINGLE connection (via `openChannel`) and closes only the
 * ephemeral test channel, leaving the connection warm for real use.
 *
 * RATIFIED (@po 2026-07-13, binding): fields are camelCase; `profileId` is the
 * only client-supplied field; the reply is {@link ProfileTestConnectionResult}.
 */
export interface ProfileTestConnectionRequest {
  type: 'profile:test-connection';
  profileId: string;
}

/**
 * Client applies a queue action to a decision (Story 2.6, AC5): `seen` marca
 * como vista (permanece na fila, marcada), `dismissed` descarta (sai da fila).
 * O server propaga como `PATCH /decisions/:id` no watcher DA VPS do perfil,
 * pelo mesmo canal SSH do poll — camada ADITIVA acima dos contratos ratificados;
 * não substitui nada. Responder decisão (send-keys) é Story 2.7, NÃO esta
 * mensagem. `decisionId` é validado como inteiro positivo no parse (nunca
 * interpolado cru em comando).
 */
export interface DecisionsActionRequest {
  type: 'decisions:action';
  profileId: string;
  decisionId: number;
  action: 'seen' | 'dismissed';
}

/**
 * Client responde uma decisão (Story 2.7, AC1/AC2/AC4): y/n ou texto livre,
 * injetado via `tmux send-keys` no canal de controle do server. Para decisão
 * `high` (ou risco desconhecido), o PRIMEIRO envio (sem `confirmToken`) NUNCA
 * executa — o server devolve `decisions:respond:challenge` com o comando exato
 * + token de uso único; só a repetição da MESMA resposta com o token envia.
 * `text` tem teto de tamanho no parse; o escaping vive no server (responder).
 */
export interface DecisionsRespondRequest {
  type: 'decisions:respond';
  profileId: string;
  decisionId: number;
  sessionName: string;
  text: string;
  confirmToken?: string;
}

/** Union of all messages a client may send. */
export type ClientToServerMessage =
  | ChannelOpenRequest
  | ChannelDataClientMessage
  | ChannelResizeMessage
  | ChannelCloseMessage
  | SessionCreateRequest
  | SessionListRequest
  | HistoryRequest
  | ProfileTestConnectionRequest
  | DecisionsActionRequest
  | DecisionsRespondRequest;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

/**
 * Server acknowledges a channel open by returning the SERVER-MINTED channelId.
 * This is the ratified shape: the server is the authority for channelId.
 */
export interface ChannelOpenAck {
  type: 'channel:open';
  profileId: string;
  channelId: string;
}

/** Server forwards channel output (stdout/stderr) to the client. */
export interface ChannelDataServerMessage {
  type: 'channel:data';
  channelId: string;
  data: string;
}

/**
 * Server notifies the client a channel was closed. `code`/`reason` distinguish a
 * user-initiated close from an error/remote close (needed by 1.4/1.5 to render
 * the reconnecting state).
 */
export interface ChannelCloseServerMessage {
  type: 'channel:close';
  channelId: string;
  code?: number;
  reason?: string;
}

/**
 * Per-profile connection state event (AC11). Surfaced over ws so a future UI can
 * render "reconnecting" without this story implementing any UI.
 */
export interface ChannelStateMessage {
  type: 'channel:state';
  profileId: string;
  state: ConnectionState;
}

/** Server reports a non-fatal error tied to a profile or channel (AC5). */
export interface ChannelErrorMessage {
  type: 'channel:error';
  profileId?: string;
  channelId?: string;
  message: string;
}

/**
 * Server acknowledges a `session:create` by returning the server-minted tmux
 * `sessionName` and the `channelId` the client can attach a terminal to (AC1).
 * camelCase (ratified @po 2026-07-12).
 */
export interface SessionCreatedAck {
  type: 'session:created';
  profileId: string;
  sessionName: string;
  channelId: string;
  /** Projeto como digitado na criação (cabeçalho de grupo na sidebar). */
  project: string;
  /** Rótulo de exibição "tema-n" (o armazenado, respeitando edição do usuário). */
  label: string;
}

/** Server returns the list of known `ckpt-*` session names for a profile (AC3). */
export interface SessionListResult {
  type: 'session:list';
  profileId: string;
  sessions: string[];
}

/** Server reports a session-scoped error (e.g. create/list failed). */
export interface SessionErrorMessage {
  type: 'session:error';
  profileId?: string;
  sessionName?: string;
  message: string;
}

/**
 * Server returns the captured tmux scrollback for a {@link HistoryRequest} (Story
 * 1.5, AC1). `data` is the raw `capture-pane -e` output (ANSI-escaped, colors
 * preserved). `channelId` correlates the reply back to the requesting tile.
 * camelCase (ratified @po 2026-07-13).
 */
export interface HistoryResult {
  type: 'history:result';
  channelId: string;
  data: string;
}

/**
 * Server reports that a history capture failed (dead session, timeout, non-ckpt
 * name). `channelId` correlates the error to the tile so it can drain its buffered
 * live stream instead of hanging (Story 1.5, AC4 — never block the tile).
 */
export interface HistoryErrorMessage {
  type: 'history:error';
  channelId: string;
  message: string;
}

/**
 * Server reports the result of a {@link ProfileTestConnectionRequest} (Story 1.6,
 * AC3). `ok` is true when the profile was reachable (already connected, or a fresh
 * connection reached `connected` within the test window); false on timeout/error,
 * with an optional human-readable `message`. camelCase (ratified @po 2026-07-13).
 */
export interface ProfileTestConnectionResult {
  type: 'profile:test-connection:result';
  profileId: string;
  ok: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Watcher sync messages (Story 2.6 — fila de decisões + status real por sessão)
// ---------------------------------------------------------------------------

/** Os 4 estados reais por sessão do watcher (PRD F7). */
export type WatcherSessionStateName = 'thinking' | 'waiting_for_input' | 'idle' | 'error';

/**
 * Item da fila de decisões como o app consome (Story 2.6, AC5). Convertido de
 * snake_case do watcher para camelCase pelo poller do server.
 *
 * `updatedAt` é o `created_at` do watcher, que semanticamente é "última
 * atualização" (o touch do regex/classificador reusa a coluna — DOC-002 do
 * gate 2.5). A UI DEVE rotular como "atualizado há X", nunca "criado há X".
 */
export interface DecisionQueueItem {
  id: number;
  sessionName: string;
  summary: string;
  risk: 'low' | 'high';
  status: 'pending' | 'seen';
  updatedAt: string;
}

/** Estado corrente de uma sessão `ckpt-*` segundo o watcher (Story 2.6, AC6). */
export interface SessionStateItem {
  sessionName: string;
  state: WatcherSessionStateName;
  /** Heartbeat: última ESCRITA do watcher (avança mesmo sem transição). */
  updatedAt: string;
  /**
   * Story 2.9/AC3 — desde quando o estado é ESTE (só avança na transição).
   * Ausente quando o watcher da VPS ainda não foi migrado, ou quando a linha
   * é anterior à migração: ausência = "desconhecido", NUNCA "há muito tempo".
   */
  stateSince?: string;
}

/**
 * Server envia a fila de decisões de um perfil (Story 2.6, AC4/AC5/AC7).
 * `watcherAvailable: false` = a VPS do perfil não tem watcher acessível — a UI
 * degrada para o comportamento Fase 1 com indicação discreta (AC3), e
 * `decisions` vem vazio. Broadcast para TODOS os sockets (a fila é agregada
 * multi-VPS e app-level — não há canal para escopar; single-operator por design).
 */
export interface DecisionsUpdateMessage {
  type: 'decisions:update';
  profileId: string;
  watcherAvailable: boolean;
  decisions: DecisionQueueItem[];
}

/**
 * Server envia o estado real por sessão de um perfil (Story 2.6, AC6). O estado
 * do watcher REFINA (não substitui) o liveness da Fase 1 — a UI decide a fusão.
 */
export interface SessionsStateMessage {
  type: 'sessions:state';
  profileId: string;
  watcherAvailable: boolean;
  states: SessionStateItem[];
  /**
   * Story 2.10/AC5 — sessões cujo re-arme de `pipe-pane` esgotou as tentativas.
   * Aditivo: ausente/vazio = nada a acusar (o cockpit ou curou, ou está curando).
   */
  unrecoverablePipes?: string[];
  /**
   * Story 2.11/AC3 — sessões cujo agente iniciou ANTES dos hooks. Aditivo:
   * ausente/vazio = nada apurado, e a UI não acusa o que não se sabe.
   */
  sessionsWithoutHooks?: string[];
  /**
   * Story 2.12 — sessões cujo agente NÃO lê `~/.claude/settings.json` (Codex).
   * Distinto de `sessionsWithoutHooks`: ali reciclar resolve, aqui não.
   */
  sessionsHooksUnsupported?: string[];
}

/** Server reporta falha de uma `decisions:action` (PATCH não aplicado). */
export interface DecisionsErrorMessage {
  type: 'decisions:error';
  profileId: string;
  decisionId?: number;
  message: string;
}

/**
 * Server exige confirmação explícita para resposta `high` (Story 2.7, AC4):
 * `command` é o comando EXATO que será executado na VPS (texto literal +
 * sessão alvo); `confirmToken` é de uso único, vinculado à resposta inteira,
 * e expira. A UI exibe o comando e só reenvia com o token após o operador
 * confirmar — impossível responder high num único round-trip.
 */
export interface DecisionsRespondChallenge {
  type: 'decisions:respond:challenge';
  profileId: string;
  decisionId: number;
  sessionName: string;
  command: string;
  confirmToken: string;
}

/**
 * Server reporta o desfecho de uma `decisions:respond` (Story 2.7, AC6/AC7).
 * `ok:false` = falha honesta (sessão morta/canal indisponível/allowlist) — a
 * decisão PERMANECE na fila; nenhum retry automático.
 */
export interface DecisionsRespondResult {
  type: 'decisions:respond:result';
  profileId: string;
  decisionId: number;
  ok: boolean;
  message?: string;
}

/** Union of all messages the server may send. */
export type ServerToClientMessage =
  | ChannelOpenAck
  | ChannelDataServerMessage
  | ChannelCloseServerMessage
  | ChannelStateMessage
  | ChannelErrorMessage
  | SessionCreatedAck
  | SessionListResult
  | SessionErrorMessage
  | HistoryResult
  | HistoryErrorMessage
  | ProfileTestConnectionResult
  | DecisionsUpdateMessage
  | SessionsStateMessage
  | DecisionsErrorMessage
  | DecisionsRespondChallenge
  | DecisionsRespondResult;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * Connection lifecycle states emitted per profile (AC11).
 * `connecting` → `connected` → (drop) → `reconnecting` → `connected` | `error`.
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';

// ---------------------------------------------------------------------------
// Runtime type guards (safe parsing of untrusted client input)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses and validates a raw JSON payload as a client→server message.
 * Returns the typed message, or `null` if the payload is not a recognized,
 * well-formed channel message. Never throws — callers route on `null`.
 */
export function parseClientMessage(raw: unknown): ClientToServerMessage | null {
  if (!isRecord(raw)) return null;
  const { type } = raw;

  switch (type) {
    case 'channel:open':
      return typeof raw.profileId === 'string'
        ? { type, profileId: raw.profileId }
        : null;

    case 'channel:data':
      return typeof raw.channelId === 'string' && typeof raw.data === 'string'
        ? { type, channelId: raw.channelId, data: raw.data }
        : null;

    case 'channel:resize':
      return typeof raw.channelId === 'string' &&
        typeof raw.cols === 'number' &&
        typeof raw.rows === 'number' &&
        Number.isFinite(raw.cols) &&
        Number.isFinite(raw.rows)
        ? { type, channelId: raw.channelId, cols: raw.cols, rows: raw.rows }
        : null;

    case 'channel:close':
      if (typeof raw.channelId !== 'string') return null;
      return {
        type,
        channelId: raw.channelId,
        ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
        ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      };

    case 'session:create':
      return typeof raw.profileId === 'string' &&
        typeof raw.projeto === 'string' &&
        typeof raw.pauta === 'string' &&
        typeof raw.agente === 'string' &&
        (raw.n === undefined || (typeof raw.n === 'number' && Number.isInteger(raw.n) && raw.n >= 0))
        ? {
            type,
            profileId: raw.profileId,
            projeto: raw.projeto,
            pauta: raw.pauta,
            agente: raw.agente,
            ...(typeof raw.n === 'number' ? { n: raw.n } : {}),
          }
        : null;

    case 'session:list':
      return typeof raw.profileId === 'string' ? { type, profileId: raw.profileId } : null;

    case 'history:request':
      return typeof raw.profileId === 'string' &&
        typeof raw.channelId === 'string' &&
        typeof raw.sessionName === 'string'
        ? { type, profileId: raw.profileId, channelId: raw.channelId, sessionName: raw.sessionName }
        : null;

    case 'profile:test-connection':
      return typeof raw.profileId === 'string' ? { type, profileId: raw.profileId } : null;

    case 'decisions:action':
      // decisionId inteiro positivo + action de allowlist: o server interpola
      // esses valores num comando na VPS — validação AQUI é a primeira barreira
      // contra injeção (a segunda vive no poller, defesa em profundidade).
      return typeof raw.profileId === 'string' &&
        typeof raw.decisionId === 'number' &&
        Number.isInteger(raw.decisionId) &&
        raw.decisionId > 0 &&
        (raw.action === 'seen' || raw.action === 'dismissed')
        ? { type, profileId: raw.profileId, decisionId: raw.decisionId, action: raw.action }
        : null;

    case 'decisions:respond':
      // Mesma disciplina anti-injeção da decisions:action: id inteiro
      // positivo; texto não-vazio com teto (2000 chars — resposta de terminal,
      // não upload); sessionName string (allowlist dura fica no responder);
      // token opcional string. O escaping do texto vive no server (responder).
      return typeof raw.profileId === 'string' &&
        typeof raw.decisionId === 'number' &&
        Number.isInteger(raw.decisionId) &&
        raw.decisionId > 0 &&
        typeof raw.sessionName === 'string' &&
        raw.sessionName.length > 0 &&
        typeof raw.text === 'string' &&
        raw.text.length > 0 &&
        raw.text.length <= 2000 &&
        (raw.confirmToken === undefined || typeof raw.confirmToken === 'string')
        ? {
            type,
            profileId: raw.profileId,
            decisionId: raw.decisionId,
            sessionName: raw.sessionName,
            text: raw.text,
            ...(typeof raw.confirmToken === 'string' ? { confirmToken: raw.confirmToken } : {}),
          }
        : null;

    default:
      return null;
  }
}
