/**
 * Typed WebSocket client wrapper (Story 1.4).
 *
 * A thin, injectable pub/sub over the browser `WebSocket` so components consume
 * the ws contract WITHOUT instantiating a socket themselves (mirrors the 1.3 DI
 * pattern: inject the transport for deterministic tests). ONE shared client is
 * created at the App level — never one per tile — coherent with "1 connection
 * per profile" server-side and avoiding amplifying ARCH-002 on the client.
 *
 * There is NO channel logic here: it only sends typed client messages and
 * dispatches typed server messages to subscribers. Filtering by channelId is the
 * subscriber's job (e.g. each TerminalTile filters for its own channelId).
 */
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '../ws-protocol.js';

/** A subscriber receives every decoded server→client message. */
export type WsMessageListener = (message: ServerToClientMessage) => void;

/** The minimal surface components depend on (easy to fake in tests). */
export interface WsClient {
  send(message: ClientToServerMessage): void;
  /** Subscribe to server messages. Returns an unsubscribe function. */
  subscribe(listener: WsMessageListener): () => void;
}

/**
 * Wraps a live browser `WebSocket` as a {@link WsClient}. Decodes incoming JSON
 * frames; frames that don't parse or aren't objects are ignored (never throw).
 */
export function createWsClient(socket: WebSocket): WsClient {
  const listeners = new Set<WsMessageListener>();

  socket.addEventListener('message', (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as ServerToClientMessage;
    for (const listener of listeners) listener(message);
  });

  return {
    send(message: ClientToServerMessage): void {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    subscribe(listener: WsMessageListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
