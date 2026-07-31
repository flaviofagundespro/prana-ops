import { createWsClient, type WsClient } from './ws-client.js';

/**
 * Builds the ONE shared {@link WsClient} for the app from a browser WebSocket
 * (Story 1.4, Task 7). A single socket is created here — never one per tile —
 * coherent with "1 connection per profile" server-side and to avoid amplifying
 * ARCH-002 on the client.
 *
 * The ws URL is derived from the current page origin (the SPA is served by the
 * same Node HTTP server that hosts the ws endpoint at `/ws`, per Story 1.1).
 */
export function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/** Creates the shared ws client connected to the given (or default) URL. */
export function createConnection(url: string = defaultWsUrl()): WsClient {
  const socket = new WebSocket(url);
  return createWsClient(socket);
}
