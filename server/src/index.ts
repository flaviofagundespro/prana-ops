/**
 * Prana OPS backend entrypoint (AC1, AC2).
 *
 * Boots the SQLite database (schema-on-startup), the Express app (REST + static
 * SPA), and the internal WebSocket server — all on a single HTTP server bound
 * to http://localhost:4000 in the MVP.
 */
import http from 'node:http';
import { PORT, HOST, DB_PATH, WS_PATH, WEB_DIST, WATCHER_PORT, WATCHER_POLL_MS } from './config.js';
import { initDatabase } from './db/schema.js';
import { ProfilesRepository } from './db/profiles.js';
import { createApp } from './http/app.js';
import { attachWebSocketServer } from './ws/index.js';
import { ProfileConnectionManager } from './transport/profile-connection-manager.js';
import { SessionMetadataRepository } from './db/session-metadata.js';
import { TmuxSessionManager } from './tmux/session-manager.js';
import { WatcherPoller } from './watcher/poller.js';
import { DecisionResponder } from './watcher/responder.js';
import { wireConnectionLifecycle } from './wiring.js';

function start(): void {
  // Rede de segurança de ÚLTIMA INSTÂNCIA (AC5 no nível do PROCESSO). O
  // connection-manager já protege cada caminho SSH, mas uma promise rejeitada
  // sem catch ou uma exceção assíncrona em QUALQUER lugar derruba o Node — foi
  // o que fechou o app sozinho ao criar uma sessão contra um profile saturado.
  // Aqui logamos e SEGUIMOS VIVOS: um erro de um profile/sessão nunca pode
  // matar o cockpit inteiro. Não mascara bugs (tudo é logado com stack), só
  // impede que um deles vire um crash de processo.
  process.on('uncaughtException', (error) => {
    // EXCEÇÃO à rede de segurança (Story 2.16): porta ocupada é falha de
    // INICIALIZAÇÃO — não há cockpit para manter vivo. O `server.on('error')`
    // abaixo NUNCA vê esse erro: `listen(port, host)` resolve o host antes de
    // bindar, e o Node LANÇA o EADDRINUSE dentro do tick do lookup, fora do
    // alcance de qualquer listener de 'error'. Sem este ramo, o processo fica
    // vivo servindo NADA e o log grava `[fatal]` — foi exatamente esse par que,
    // em 2026-07-29, foi lido como "processo fantasma" e custou meia hora de
    // diagnóstico na direção errada.
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'EADDRINUSE' && failure.syscall === 'listen') {
      console.error(`[http] port ${PORT} is already in use. Is the cockpit already running?`);
      process.exit(1);
    }
    console.error('[fatal] uncaughtException (mantendo o processo vivo):', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection (mantendo o processo vivo):', reason);
  });

  let db;
  try {
    db = initDatabase(DB_PATH);
    console.log(`[db] SQLite ready at ${DB_PATH}`);
  } catch (error) {
    console.error('[db] failed to open SQLite database:', error);
    process.exit(1);
  }

  // SSH transport (Story 1.2): one connection per profile, N shell channels.
  const profiles = new ProfilesRepository(db);
  const connectionManager = new ProfileConnectionManager({ profiles });
  // AC5: never let a surfaced SSH error crash the process — log and continue.
  connectionManager.on('channelError', ({ profileId, channelId, message }) => {
    console.error(`[ssh] error (profile=${profileId}${channelId ? ` channel=${channelId}` : ''}): ${message}`);
  });
  connectionManager.on('state', ({ profileId, state }) => {
    console.log(`[ssh] profile ${profileId} → ${state}`);
  });

  // tmux session layer (Story 1.3): create-or-attach ckpt-* sessions over the
  // existing SSH channels, adopt existing sessions, reconcile liveness ~10s.
  const sessionMetadata = new SessionMetadataRepository(db);
  const tmuxManager = new TmuxSessionManager({
    transport: connectionManager,
    metadata: sessionMetadata,
  });
  tmuxManager.on('sessionError', ({ profileId, sessionName }) => {
    console.warn(`[tmux] session ${sessionName} (profile=${profileId}) marked error (vanished from tmux ls)`);
  });

  // Story 2.6: poller do watcher — sincroniza fila de decisões + estado por
  // sessão executando `curl` no 127.0.0.1 DA VPS pelo canal de controle SSH
  // (runHostQuery). Mesmo ciclo de vida da reconciliação (wiring abaixo).
  const watcherPoller = new WatcherPoller({
    queryRunner: tmuxManager,
    watcherPort: WATCHER_PORT,
    intervalMs: WATCHER_POLL_MS,
  });

  // ARCH-003 (Story 1.4): finally invoke the dormant runtime paths. On a profile
  // reaching `connected`, adopt its existing ckpt-* sessions and start the
  // reconciliation loop; on `closed`/`error`, stop that profile's loop. Wiring is
  // extracted to a pure, testable function (see `wiring.ts`).
  wireConnectionLifecycle({ connectionManager, tmuxManager, watcherPoller });

  // SMK-003: excluir um perfil derruba a conexão SSH e para a reconciliação —
  // sem isso, a máquina de reconexão do perfil excluído tenta handshake para
  // sempre em background.
  const app = createApp({
    db,
    webDist: WEB_DIST,
    onProfileDeleted: (profileId) => {
      tmuxManager.stopReconciliation(profileId);
      connectionManager.disconnect(profileId);
    },
    // Story 1.7: deletar sessão mata o tmux na VPS (guard ckpt- no killSession).
    onSessionDelete: (profileId, sessionName) => tmuxManager.killSession(profileId, sessionName),
  });
  const server = http.createServer(app);

  // Story 2.7: resposta do painel — send-keys sanitizado no canal de controle,
  // allowlist + gate high (token de uso único) POR CONSTRUÇÃO no server.
  const decisionResponder = new DecisionResponder({
    queryRunner: tmuxManager,
    decisions: watcherPoller,
    watcherPort: WATCHER_PORT,
  });

  const wss = attachWebSocketServer({
    server,
    path: WS_PATH,
    connectionManager,
    tmuxManager,
    watcherPoller,
    decisionResponder,
    // Story 2.10/AC5: quem sabe do cano é o tmuxManager (não o watcher); a
    // informação viaja junto do sessions:state para não criar round-trip novo.
    unrecoverablePipes: (profileId) => tmuxManager.unrecoverablePipes(profileId),
    // Story 2.11/AC3: mesma via — quem sabe do processo do agente é o tmuxManager.
    sessionsWithoutHooks: (profileId) => tmuxManager.sessionsWithoutHooks(profileId),
    sessionsHooksUnsupported: (profileId) => tmuxManager.sessionsHooksUnsupported(profileId),
  });
  console.log(`[ws] WebSocket server listening on ${WS_PATH}`);

  // Erros do servidor DEPOIS do bind. A falha do próprio `listen` não chega
  // aqui (ver o ramo EADDRINUSE no `uncaughtException` acima) — este handler
  // cobre o que acontece com o socket já de pé.
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('[http] server error:', error);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[http] Prana OPS listening on http://localhost:${PORT}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n[shutdown] received ${signal}, closing...`);
    watcherPoller.stopAllPolling();
    tmuxManager.stopAllReconciliation();
    connectionManager.disconnectAll();
    wss.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
