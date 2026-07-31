/**
 * Frontend mirror of the ws channel protocol (AC9).
 *
 * CANONICAL SOURCE: `server/src/ws/protocol.ts`. This file is a TYPE-ONLY mirror
 * so the frontend can consume the same contract WITHOUT a cross-package import
 * (web/ and server/ are isolated tsconfig roots with different lib targets —
 * DOM vs Node — so importing server code into web would drag Node types into the
 * browser build). If you change the contract, change it in the server file first,
 * then update this mirror. There is no runtime code here; nothing to diverge but
 * the type shapes, which Story 1.4 will exercise against the server.
 *
 * RATIFIED CONTRACT (@po, 2026-07-12): the SERVER mints `channelId`; the client
 * sends `channel:open` with `profileId` only and receives an ack carrying the
 * server-minted `channelId`. `channel:close` carries optional `code`/`reason`.
 */

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed';

// Client → Server -----------------------------------------------------------

export interface ChannelOpenRequest {
  type: 'channel:open';
  profileId: string;
}

export interface ChannelDataClientMessage {
  type: 'channel:data';
  channelId: string;
  data: string;
}

export interface ChannelResizeMessage {
  type: 'channel:resize';
  channelId: string;
  cols: number;
  rows: number;
}

export interface ChannelCloseMessage {
  type: 'channel:close';
  channelId: string;
  code?: number;
  reason?: string;
}

/**
 * Client asks the server to create-or-attach a tmux `ckpt-*` session (Story 1.3,
 * AC1). Mirror of the server `SessionCreateRequest`. Story 1.4 consumes this from
 * the SessionForm. camelCase fields, ratified @po 2026-07-12.
 */
export interface SessionCreateRequest {
  type: 'session:create';
  profileId: string;
  projeto: string;
  pauta: string;
  agente: string;
  n?: number;
}

/** Client asks for the list of known `ckpt-*` sessions on a profile (AC3). */
export interface SessionListRequest {
  type: 'session:list';
  profileId: string;
}

/**
 * Client requests the visible scrollback history of a tile's tmux session (Story
 * 1.5, AC1/AC4/AC5). Mirror of the server `HistoryRequest`. `channelId` is the
 * correlation key; the tile filters the reply by its own `channelId`. camelCase,
 * ratified @po 2026-07-13.
 */
export interface HistoryRequest {
  type: 'history:request';
  profileId: string;
  channelId: string;
  sessionName: string;
}

/**
 * Client asks the server to TEST reachability of a profile's SSH connection
 * (Story 1.6, AC3). Mirror of the server `ProfileTestConnectionRequest`. Additive
 * layer; never opens a second persistent connection server-side. camelCase,
 * ratified @po 2026-07-13.
 */
export interface ProfileTestConnectionRequest {
  type: 'profile:test-connection';
  profileId: string;
}

/**
 * Client aplica uma ação da fila a uma decisão (Story 2.6, AC5): `seen` marca
 * como vista, `dismissed` descarta. Mirror do server `DecisionsActionRequest`.
 * Responder decisão (send-keys) é Story 2.7 — NÃO é esta mensagem. camelCase,
 * aditivo aos contratos ratificados.
 */
export interface DecisionsActionRequest {
  type: 'decisions:action';
  profileId: string;
  decisionId: number;
  action: 'seen' | 'dismissed';
}

/**
 * Client responde uma decisão (Story 2.7, AC1/AC4). Mirror do server
 * `DecisionsRespondRequest`. Para `high`, o 1º envio (sem `confirmToken`) volta
 * como `decisions:respond:challenge`; só a repetição com o token envia. O
 * escaping vive no server — a UI só manda o texto cru.
 */
export interface DecisionsRespondRequest {
  type: 'decisions:respond';
  profileId: string;
  decisionId: number;
  sessionName: string;
  text: string;
  confirmToken?: string;
}

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

// Server → Client -----------------------------------------------------------

export interface ChannelOpenAck {
  type: 'channel:open';
  profileId: string;
  channelId: string;
}

export interface ChannelDataServerMessage {
  type: 'channel:data';
  channelId: string;
  data: string;
}

export interface ChannelCloseServerMessage {
  type: 'channel:close';
  channelId: string;
  code?: number;
  reason?: string;
}

export interface ChannelStateMessage {
  type: 'channel:state';
  profileId: string;
  state: ConnectionState;
}

export interface ChannelErrorMessage {
  type: 'channel:error';
  profileId?: string;
  channelId?: string;
  message: string;
}

/**
 * Server acknowledges a `session:create` with the server-minted tmux
 * `sessionName` and the `channelId` a terminal can attach to (AC1). Mirror of the
 * server `SessionCreatedAck`. `channelId` is the STABLE tile key (survives
 * reconnect).
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
 * 1.5, AC1). Mirror of the server `HistoryResult`. `data` is the raw
 * `capture-pane -e` output (ANSI-escaped). `channelId` correlates to the tile.
 */
export interface HistoryResult {
  type: 'history:result';
  channelId: string;
  data: string;
}

/**
 * Server reports that a history capture failed (Story 1.5, AC4). Mirror of the
 * server `HistoryErrorMessage`. The tile drains its buffered live stream on this
 * so it never hangs waiting for history.
 */
export interface HistoryErrorMessage {
  type: 'history:error';
  channelId: string;
  message: string;
}

/**
 * Server reports the result of a {@link ProfileTestConnectionRequest} (Story 1.6,
 * AC3). Mirror of the server `ProfileTestConnectionResult`. `ok` true = reachable;
 * false + optional `message` on timeout/error. camelCase, ratified @po 2026-07-13.
 */
export interface ProfileTestConnectionResult {
  type: 'profile:test-connection:result';
  profileId: string;
  ok: boolean;
  message?: string;
}

// Watcher sync (Story 2.6) — mirrors dos tipos do server -------------------

/** Os 4 estados reais por sessão do watcher (PRD F7). */
export type WatcherSessionStateName = 'thinking' | 'waiting_for_input' | 'idle' | 'error';

/**
 * Item da fila de decisões como o app consome (Story 2.6, AC5). Mirror do
 * server `DecisionQueueItem`. `updatedAt` é semanticamente "última
 * atualização" (DOC-002 do gate 2.5) — a UI rotula "atualizado há X", nunca
 * "criado há X".
 */
export interface DecisionQueueItem {
  id: number;
  sessionName: string;
  summary: string;
  risk: 'low' | 'high';
  status: 'pending' | 'seen';
  updatedAt: string;
}

/** Estado corrente de uma sessão `ckpt-*` segundo o watcher (AC6). */
export interface SessionStateItem {
  sessionName: string;
  state: WatcherSessionStateName;
  /** Heartbeat: última ESCRITA do watcher (avança mesmo sem transição). */
  updatedAt: string;
  /**
   * Story 2.9/AC3 — desde quando o estado é ESTE (só avança na transição).
   * Ausente quando o watcher da VPS ainda não foi migrado: ausência =
   * "desconhecido", NUNCA "há muito tempo". Mirror do server.
   */
  stateSince?: string;
}

/**
 * Fila de decisões de um perfil (Story 2.6, AC4/AC5/AC7). Mirror do server
 * `DecisionsUpdateMessage`. `watcherAvailable: false` = degradar para Fase 1
 * com indicação discreta (AC3).
 */
export interface DecisionsUpdateMessage {
  type: 'decisions:update';
  profileId: string;
  watcherAvailable: boolean;
  decisions: DecisionQueueItem[];
}

/**
 * Estado real por sessão de um perfil (Story 2.6, AC6). Mirror do server
 * `SessionsStateMessage`. Refina (não substitui) o liveness da Fase 1.
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

/** Falha de uma `decisions:action`. Mirror do server `DecisionsErrorMessage`. */
export interface DecisionsErrorMessage {
  type: 'decisions:error';
  profileId: string;
  decisionId?: number;
  message: string;
}

/**
 * Confirmação exigida para resposta `high` (Story 2.7, AC4). Mirror do server
 * `DecisionsRespondChallenge`. A UI exibe `command` (o comando EXATO) e só
 * reenvia com `confirmToken` (uso único) após o operador confirmar.
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
 * Desfecho de uma `decisions:respond` (Story 2.7, AC6/AC7). Mirror do server
 * `DecisionsRespondResult`. `ok:false` = falha honesta — a decisão fica na fila.
 */
export interface DecisionsRespondResult {
  type: 'decisions:respond:result';
  profileId: string;
  decisionId: number;
  ok: boolean;
  message?: string;
}

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
