/**
 * Central configuration for the Prana OPS backend.
 *
 * Values are read from the environment with sane defaults so the app boots
 * with zero configuration in the Phase 1 MVP (`npm start`).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** HTTP + WebSocket port. AC1 mandates http://localhost:4000. */
export const PORT = Number(process.env.PORT ?? 4000);

/**
 * Host to bind. Loopback, and loopback only.
 *
 * The cockpit has NO authentication: every WebSocket client can list sessions,
 * read scrollback and type into live agent sessions. That is defensible while
 * the only reachable clients are on this machine, and indefensible the moment
 * the socket faces a network — so a non-loopback `HOST` is refused at boot
 * rather than honoured. Exposing it deliberately is a decision that requires
 * authentication first, not an environment variable (2026-07-30).
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const HOST = ((): string => {
  const requested = process.env.HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(requested)) {
    throw new Error(
      `refusing to bind HOST=${JSON.stringify(requested)}: the cockpit is unauthenticated and ` +
        `may only listen on loopback (${[...LOOPBACK_HOSTS].join(', ')}). ` +
        `Use an SSH tunnel or a private network to reach it from elsewhere.`,
    );
  }
  return requested;
})();

/**
 * SQLite database file location. Treated as cache/metadata, never source of
 * truth (see PRD F9). Overridable for tests via COCKPIT_DB_PATH.
 */
export const DB_PATH =
  process.env.COCKPIT_DB_PATH ?? path.resolve(__dirname, '..', 'data', 'cockpit.db');

/** WebSocket upgrade path exposed by the backend (channels arrive in Story 1.2). */
export const WS_PATH = process.env.WS_PATH ?? '/ws';

/** Absolute path to the built frontend (Vite output) served statically. */
export const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');

/**
 * Porta em que o watcher (Fase 2) escuta NA VPS — o `curl` do poller roda lá,
 * via canal SSH; a porta nunca é exposta/atravessa a rede (Story 2.6, AC1).
 */
export const WATCHER_PORT = Number(process.env.WATCHER_PORT ?? 4100);

/** Intervalo de poll da fila/estado do watcher (Story 2.6, AC2). Default 10s. */
export const WATCHER_POLL_MS = Number(process.env.WATCHER_POLL_MS ?? 10_000);
