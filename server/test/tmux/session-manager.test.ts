/**
 * TmuxSessionManager tests (Story 1.3, AC1/AC3/AC4/AC5/AC6/AC9/AC10, Tasks 2-5).
 *
 * All I/O is mocked: a FakeTransport stands in for the ConnectionManager (proving
 * this layer NEVER opens a second connection — it only calls openChannel/sendData/
 * closeChannel), and an in-memory SQLite DB backs the metadata repo. A fake
 * scheduler drives the reconciliation loop and query timeouts deterministically.
 *
 * Covers:
 *  - createOrAttach builds the exact attach-or-create command + pipe-pane, uses
 *    exactly ONE channel, and records metadata (AC1, AC2, AC5, AC9);
 *  - AGENT_COMMANDS map: claude/codex resolve to configured commands, unknown =
 *    free-form literal (ratified decision #3);
 *  - listCkptSessions parses `tmux ls`, adopting ONLY ckpt-* (AC3, AC4), tolerant
 *    of mixed/empty/malformed output;
 *  - the delimiter read strategy handles a delimiter appearing INSIDE the payload
 *    (delimiter-in-payload safety, ratified decision #1);
 *  - reconcileOnce marks a vanished session `error` and emits sessionError (AC6);
 *  - the reconcile loop is driven by the injected scheduler (no real timers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  TmuxSessionManager,
  AGENT_COMMANDS,
  QUERY_DELIMITER,
  parseSessionList,
  parsePipeStates,
  parseHookCoverage,
} from '../../src/tmux/session-manager.js';
import type { ChannelTransport } from '../../src/tmux/session-manager.js';
import { initDatabase } from '../../src/db/schema.js';
import { ProfilesRepository } from '../../src/db/profiles.js';
import { SessionMetadataRepository } from '../../src/db/session-metadata.js';
import type { CockpitDatabase } from '../../src/db/schema.js';

/**
 * Fake transport: records every channel operation and lets tests emit `data`.
 * Critically, it exposes ONLY openChannel/sendData/closeChannel/on/off — so the
 * manager under test cannot reach a second connection path (AC9).
 */
class FakeTransport extends EventEmitter implements ChannelTransport {
  opened: string[] = [];
  sent: Array<{ channelId: string; data: string }> = [];
  closed: Array<{ channelId: string; reason?: string }> = [];
  private seq = 0;

  openChannel(profileId: string): string {
    this.opened.push(profileId);
    this.seq += 1;
    return `${profileId}:${this.seq}`;
  }
  sendData(_profileId: string, channelId: string, data: string): void {
    this.sent.push({ channelId, data });
  }
  closeChannel(_profileId: string, channelId: string, reason?: string): void {
    this.closed.push({ channelId, reason });
  }
  /** Simulate output arriving on a channel. */
  feed(profileId: string, channelId: string, text: string): void {
    this.emit('data', { profileId, channelId, data: Buffer.from(text, 'utf8') });
  }
}

/** A manual scheduler queue for deterministic timer control. */
function makeScheduler(): {
  scheduler: (fn: () => void, ms: number) => void;
  cancel: (h: unknown) => void;
  runNext: () => void;
  pending: () => number;
} {
  const queue: Array<{ id: number; fn: () => void }> = [];
  let id = 0;
  const scheduler = (fn: () => void): number => {
    id += 1;
    queue.push({ id, fn });
    return id;
  };
  const cancel = (h: unknown): void => {
    const idx = queue.findIndex((q) => q.id === h);
    if (idx !== -1) queue.splice(idx, 1);
  };
  const runNext = (): void => {
    const next = queue.shift();
    if (next) next.fn();
  };
  return { scheduler, cancel, runNext, pending: () => queue.length };
}

describe('TmuxSessionManager', () => {
  let db: CockpitDatabase;
  let metadata: SessionMetadataRepository;
  let transport: FakeTransport;
  let profileId: number;

  beforeEach(() => {
    db = initDatabase(':memory:');
    metadata = new SessionMetadataRepository(db);
    transport = new FakeTransport();
    profileId = new ProfilesRepository(db).create({
      name: 'vps',
      host: 'h',
      user: 'u',
      keyPath: '/k',
    }).id;
  });

  function makeManager(overrides: Partial<{
    agentCommands: Record<string, string>;
    scheduler: (fn: () => void, ms: number) => void;
    cancelScheduler: (h: unknown) => void;
    reconcileIntervalMs: number;
    queryTimeoutMs: number;
    maxPipeRearmAttempts: number;
  }> = {}): TmuxSessionManager {
    return new TmuxSessionManager({
      transport,
      metadata,
      agentCommands: overrides.agentCommands,
      scheduler: overrides.scheduler,
      cancelScheduler: overrides.cancelScheduler,
      reconcileIntervalMs: overrides.reconcileIntervalMs,
      maxPipeRearmAttempts: overrides.maxPipeRearmAttempts,
      queryTimeoutMs: overrides.queryTimeoutMs,
    });
  }

  describe('createOrAttach (AC1, AC2, AC5, AC9)', () => {
    it('builds attach-or-create + pipe-pane over exactly ONE channel', () => {
      const mgr = makeManager();
      const { sessionName, channelId } = mgr.createOrAttach(String(profileId), 'pranaops', 'claude', 1, { agenda: 'watcher' });

      expect(sessionName).toBe('ckpt-pranaops-watcher-1');
      // Exactly one channel opened for the session (1 session = 1 channel = 1 terminal).
      expect(transport.opened).toEqual([String(profileId)]);
      expect(channelId).toBe(`${profileId}:1`);

      const cmds = transport.sent.filter((s) => s.channelId === channelId).map((s) => s.data);
      // SMK-006/SMK-010: UMA linha idempotente — mkdir do log dir + new-session
      // com pipe-pane encadeado atomicamente via `\;` (antes, o pipe-pane era uma
      // 2ª linha de shell que acabava digitada DENTRO da sessão e nunca rodava).
      // Decisão de produto (2026-07-14): a sessão nasce em shell puro — agente é
      // só rótulo; o operador ativa o agente manualmente dentro do tmux.
      expect(cmds).toEqual([
        'mkdir -p ~/.cockpit/logs; ' +
          "tmux new-session -A -s 'ckpt-pranaops-watcher-1' \\; " +
          "pipe-pane -o 'cat >> ~/.cockpit/logs/ckpt-pranaops-watcher-1.log'\n",
      ]);
    });

    it('records session_metadata (cache) on create and updates on re-attach', () => {
      const mgr = makeManager();
      mgr.createOrAttach(String(profileId), 'proj', 'codex', 2, { agenda: 'topic' });

      const row = metadata.getByProfileAndSessionName(profileId,'ckpt-proj-topic-2');
      expect(row?.agent).toBe('codex');
      expect(row?.agenda).toBe('topic');
      expect(row?.status).toBe('active');

      // Re-attach doesn't create a duplicate row.
      mgr.createOrAttach(String(profileId), 'proj', 'codex', 2, { agenda: 'topic' });
      expect(metadata.listByProfile(profileId).filter((r) => r.sessionName === 'ckpt-proj-topic-2')).toHaveLength(1);
    });

    it('auto-fills the display label as tema-n on CREATE only (sem projeto, sem CLI)', () => {
      // Decisão de produto (2026-07-15): projeto é o cabeçalho do grupo na
      // sidebar e o CLI é ferramenta do momento — o label é só "tema-n".
      const mgr = makeManager();
      const created = mgr.createOrAttach(String(profileId), 'Maq', 'codex', 1, { agenda: 'Ajustes finais' });

      const row = metadata.getByProfileAndSessionName(profileId, 'ckpt-maq-ajustes-finais-1');
      expect(row?.label).toBe('ajustes-finais-1');
      // O ack devolve project + label para o frontend compor a aba.
      expect(created.project).toBe('Maq');
      expect(created.label).toBe('ajustes-finais-1');

      // Usuário edita o label; o re-attach NÃO sobrescreve e devolve o editado.
      metadata.update(row!.id, { label: 'meu-label' });
      // Story 2.12: reabrir é com o MESMO assunto — assunto diferente é outra
      // sessão, porque o assunto agora faz parte da identidade do trabalho.
      const reattached = mgr.createOrAttach(String(profileId), 'Maq', 'codex', 1, { agenda: 'Ajustes finais' });
      expect(metadata.get(row!.id)?.label).toBe('meu-label');
      expect(reattached.label).toBe('meu-label');

      // Story 2.12: sem assunto, cai para `geral-n` — não para o CLI.
      // Story 2.12: sem agenda, nome E label caem em `geral` — nunca no CLI.
      mgr.createOrAttach(String(profileId), 'acme', 'claude', 2);
      expect(metadata.getByProfileAndSessionName(profileId, 'ckpt-acme-geral-2')?.label).toBe('geral-2');
    });

    it('keeps separate metadata rows for the SAME session name on two profiles', () => {
      // Colisão cross-VPS (campo, 2026-07-14): tmux tem namespace POR HOST, então
      // ckpt-equipe-claude-1 pode existir nas duas VPS ao mesmo tempo. O upsert
      // global antigo sequestrava a linha da outra VPS (a sessão nascia no tmux
      // mas nunca aparecia na UI) — o upsert deve ser escopado por perfil.
      const otherProfileId = new ProfilesRepository(db).create({
        name: 'vps2',
        host: 'h2',
        user: 'u2',
        keyPath: '/k2',
      }).id;

      const mgr = makeManager();
      mgr.createOrAttach(String(profileId), 'equipe', 'claude', 1, { agenda: 'onda' });
      mgr.createOrAttach(String(otherProfileId), 'equipe', 'claude', 1, { agenda: 'onda' });

      const first = metadata.getByProfileAndSessionName(profileId, 'ckpt-equipe-onda-1');
      const second = metadata.getByProfileAndSessionName(otherProfileId, 'ckpt-equipe-onda-1');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.id).not.toBe(second!.id);
      expect(first!.profileId).toBe(profileId);
      expect(second!.profileId).toBe(otherProfileId);
    });

    it('resolves agent commands via the configurable AGENT_COMMANDS map (ratified #3)', () => {
      const mgr = makeManager();
      expect(mgr.resolveAgentCommand('claude')).toBe(AGENT_COMMANDS.claude);
      expect(mgr.resolveAgentCommand('codex')).toBe(AGENT_COMMANDS.codex);
      // Unknown agent = free-form command, used literally.
      expect(mgr.resolveAgentCommand('htop')).toBe('htop');
    });

    it('honors an overridden agent-command map (configurable, not inline)', () => {
      // Decisão de produto (2026-07-14): o agente NÃO é mais executado na criação
      // (sessão nasce em shell puro; agente é rótulo). O mapa configurável segue
      // exposto via resolveAgentCommand para usos futuros (ex.: Fase 2 respond).
      const mgr = makeManager({ agentCommands: { claude: 'claude --dangerously' } });
      expect(mgr.resolveAgentCommand('claude')).toBe('claude --dangerously');
      mgr.createOrAttach(String(profileId), 'p', 'claude', 0, { agenda: 'watcher' });
      const cmd = transport.sent[0].data;
      // O comando de criação não contém o binário do agente — só o attach + pipe-pane.
      expect(cmd).not.toContain('claude --dangerously');
      expect(cmd).toContain("tmux new-session -A -s 'ckpt-p-watcher-0'");
    });

    it('refuses to build a command for a non-ckpt name (allowlist, AC4)', () => {
      const mgr = makeManager();
      // A projeto that sanitizes to empty cannot produce a valid ckpt- name.
      expect(() => mgr.createOrAttach(String(profileId), '***', 'claude', 1)).toThrow(/projeto/);
    });
  });

  describe('listCkptSessions / adoption (AC3, AC4)', () => {
    it('adopts ONLY ckpt-* sessions from mixed tmux ls output', async () => {
      const mgr = makeManager({ queryTimeoutMs: 1000 });
      // Drive the query: capture the channel the manager opened, then feed output.
      const promise = mgr.listCkptSessions(String(profileId));
      const queryChannel = transport.opened.length; // seq of the just-opened channel
      const channelId = `${profileId}:${queryChannel}`;
      transport.feed(
        String(profileId),
        channelId,
        // Mixed: user's manual sessions + ckpt- sessions, then the delimiter.
        `ckpt-a-claude-1\nmain\n4terminal\nckpt-b-codex-2\n${QUERY_DELIMITER}\n`,
      );
      const names = await promise;
      expect(names).toEqual(['ckpt-a-claude-1', 'ckpt-b-codex-2']);
      // The query channel was closed after reading (short-lived).
      expect(transport.closed.some((c) => c.channelId === channelId)).toBe(true);
    });

    it('handles empty tmux ls output without error', async () => {
      const mgr = makeManager();
      const promise = mgr.listCkptSessions(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `${QUERY_DELIMITER}\n`);
      expect(await promise).toEqual([]);
    });

    it('inserts minimal metadata rows for adopted sessions (heuristic)', async () => {
      const mgr = makeManager();
      const promise = mgr.adoptExistingSessions(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `ckpt-pranaops-claude-3\n${QUERY_DELIMITER}\n`);
      const adopted = await promise;
      expect(adopted).toEqual(['ckpt-pranaops-claude-3']);

      const row = metadata.getByProfileAndSessionName(profileId,'ckpt-pranaops-claude-3');
      expect(row?.project).toBe('pranaops'); // parsed best-effort
      // Story 2.12/AC4: `agent` NÃO vem mais do nome — era daqui que a mentira
      // nascia (`ckpt-acme-claude-1` rodando Codex gravava agent='claude').
      // O segmento do meio é ASSUNTO; o agente real vem do processo (2.11).
      expect(row?.agent).toBeNull();
      expect(row?.agenda).toBe('claude');
      expect(row?.status).toBe('active');
    });

    it('does not re-adopt a session that already has metadata', async () => {
      metadata.create({ profileId, sessionName: 'ckpt-x-y-1', status: 'active' });
      const mgr = makeManager();
      const promise = mgr.adoptExistingSessions(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `ckpt-x-y-1\n${QUERY_DELIMITER}\n`);
      expect(await promise).toEqual([]); // nothing newly adopted
    });
  });

  describe('capturePane (Story 1.5, AC1, AC2, AC5, AC6)', () => {
    it('builds the exact capture-pane command with -e -p -S -500 over the query channel', async () => {
      const mgr = makeManager({ queryTimeoutMs: 1000 });
      const promise = mgr.capturePane(String(profileId), 'ckpt-a-claude-1');
      const channelId = `${profileId}:${transport.opened.length}`;

      // The exact command string sent to the short-lived query channel. `-e` (ANSI
      // colors) and `-S -500` (history window) are NEVER omitted (AC2).
      const cmd = transport.sent.find((s) => s.channelId === channelId)?.data;
      expect(cmd).toBe(
        "tmux capture-pane -e -p -S -500 -t 'ckpt-a-claude-1'; echo '___CKPT_DONE___'\n",
      );

      // Feed a captured pane containing ANSI escapes, then the delimiter.
      const ansiHistory = '[32mline1[0m\n[31mline2[0m\n';
      transport.feed(String(profileId), channelId, `${ansiHistory}${QUERY_DELIMITER}\n`);
      const data = await promise;

      // The ANSI escapes are preserved verbatim (AC2 — colors, not plain text).
      expect(data).toBe(ansiHistory);
      // Short-lived query channel was closed after reading (AC5 — no lingering channel).
      expect(transport.closed.some((c) => c.channelId === channelId)).toBe(true);
    });

    it('captures over ONE query channel on the SAME profile connection (AC5 — no 2nd connection)', async () => {
      const mgr = makeManager({ queryTimeoutMs: 1000 });
      const before = transport.opened.length;
      const promise = mgr.capturePane(String(profileId), 'ckpt-b-codex-2');
      // Exactly ONE additional channel opened, on this profile — reusing the
      // transport (openChannel), never a second SSH connection path.
      expect(transport.opened.length).toBe(before + 1);
      expect(transport.opened[transport.opened.length - 1]).toBe(String(profileId));

      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `scrollback\n${QUERY_DELIMITER}\n`);
      await promise;
    });

    it('rejects (throws) a sessionName that fails the ckpt- allowlist (AC5, AC6)', async () => {
      const mgr = makeManager();
      // Non-ckpt name must throw at command-construction time — no command is sent.
      await expect(mgr.capturePane(String(profileId), 'main')).rejects.toThrow(/non-ckpt/);
      await expect(mgr.capturePane(String(profileId), '4terminal')).rejects.toThrow(/non-ckpt/);
      // No capture-pane command ever hit the transport for the rejected names.
      expect(transport.sent.some((s) => s.data.includes('capture-pane'))).toBe(false);
    });

    it('resolves via timeout if the delimiter never arrives (never hangs)', async () => {
      const { scheduler, cancel, runNext } = makeScheduler();
      const mgr = makeManager({ scheduler, cancelScheduler: cancel, queryTimeoutMs: 100 });
      const promise = mgr.capturePane(String(profileId), 'ckpt-a-claude-1');
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, 'partial history'); // no delimiter
      runNext(); // fire the timeout
      // SMK-004: timeout = consulta não confiável → histórico vazio, nunca
      // conteúdo parcial (que poderia intercalar com o stream ao vivo).
      expect(await promise).toBe('');
    });
  });

  describe('delimiter-in-payload safety (ratified #1)', () => {
    it('treats a delimiter that appears INSIDE the payload as the terminator boundary', async () => {
      // If a session name (absurdly) contained the delimiter token, the read must
      // stop at the FIRST delimiter and everything before it is the payload.
      const mgr = makeManager();
      const promise = mgr.listCkptSessions(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      // Payload has ckpt-a-claude-1, then delimiter; anything AFTER is ignored.
      transport.feed(
        String(profileId),
        channelId,
        `ckpt-a-claude-1\n${QUERY_DELIMITER}\nckpt-should-be-ignored-9\n${QUERY_DELIMITER}\n`,
      );
      const names = await promise;
      // Only the content BEFORE the first delimiter is parsed.
      expect(names).toEqual(['ckpt-a-claude-1']);
      expect(names).not.toContain('ckpt-should-be-ignored-9');
    });

    it('resolves via timeout if the delimiter never arrives (never hangs)', async () => {
      const { scheduler, cancel, runNext } = makeScheduler();
      const mgr = makeManager({ scheduler, cancelScheduler: cancel, queryTimeoutMs: 100 });
      const promise = mgr.listCkptSessions(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `ckpt-a-claude-1\n`); // no delimiter
      runNext(); // fire the timeout
      const names = await promise;
      // SMK-004: timeout = null (consulta não confiável) — NUNCA lista parcial,
      // que fazia a reconciliação marcar sessões vivas como error quando a
      // consulta falhava (visto no smoke E2E contra a VPS real).
      expect(names).toBeNull();
    });
  });

  describe('reconciliation (AC6)', () => {
    it('marks a vanished ckpt- session as error and emits sessionError', async () => {
      const mgr = makeManager();
      // Two known sessions.
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });
      metadata.create({ profileId, sessionName: 'ckpt-b-codex-1', status: 'active' });

      const errors: string[] = [];
      mgr.on('sessionError', ({ sessionName }) => errors.push(sessionName));

      // tmux ls now only lists the first — the second was killed out-of-band.
      const promise = mgr.reconcileOnce(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `ckpt-a-claude-1\n${QUERY_DELIMITER}\n`);
      await promise;

      expect(errors).toEqual(['ckpt-b-codex-1']);
      expect(metadata.getByProfileAndSessionName(profileId,'ckpt-b-codex-1')?.status).toBe('error');
      expect(metadata.getByProfileAndSessionName(profileId,'ckpt-a-claude-1')?.status).toBe('active');
    });

    it('restores a session to active if it reappears in tmux ls', async () => {
      const mgr = makeManager();
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'error' });

      const promise = mgr.reconcileOnce(String(profileId));
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `ckpt-a-claude-1\n${QUERY_DELIMITER}\n`);
      await promise;

      expect(metadata.getByProfileAndSessionName(profileId,'ckpt-a-claude-1')?.status).toBe('active');
    });

    it('drives the reconcile loop via the injected scheduler (no real timers)', () => {
      const { scheduler, cancel, pending } = makeScheduler();
      const mgr = makeManager({ scheduler, cancelScheduler: cancel, reconcileIntervalMs: 10_000 });

      expect(pending()).toBe(0);
      mgr.startReconciliation(String(profileId));
      expect(pending()).toBe(1); // one tick armed

      // Starting again is idempotent (no duplicate loop).
      mgr.startReconciliation(String(profileId));
      expect(pending()).toBe(1);

      mgr.stopReconciliation(String(profileId));
      expect(pending()).toBe(0);
    });
  });

  describe('killSession (Story 1.7)', () => {
    it('kills the tmux session over a query channel and deletes local metadata', async () => {
      const mgr = makeManager();
      metadata.create({ profileId, sessionName: 'ckpt-smoke-htop-1', status: 'active' });

      const promise = mgr.killSession(String(profileId), 'ckpt-smoke-htop-1');
      const channelId = `${profileId}:${transport.opened.length}`;
      // O comando construído é exatamente o kill-session allowlisted.
      expect(transport.sent[0].data).toContain("tmux kill-session -t 'ckpt-smoke-htop-1'");
      transport.feed(String(profileId), channelId, `${QUERY_DELIMITER}\n`);
      await promise;

      expect(metadata.getByProfileAndSessionName(profileId,'ckpt-smoke-htop-1')).toBeNull();
      // Canal de query fechado (curto, mesma conexão).
      expect(transport.closed.some((c) => c.channelId === channelId)).toBe(true);
    });

    it('refuses to kill a non-ckpt session (allowlist, restriction #3)', async () => {
      const mgr = makeManager();
      await expect(mgr.killSession(String(profileId), 'main')).rejects.toThrow(/non-ckpt/);
      // Nenhum comando chegou ao transporte.
      expect(transport.sent.some((s) => s.data.includes('kill-session'))).toBe(false);
    });
  });

  /**
   * Story 2.10 — re-arme automático do pipe-pane.
   *
   * Testa o CONTRATO operacional, não aparência: o comando exato (reset
   * close→open, jamais `-o`), a allowlist, e a disciplina de nunca tratar
   * consulta não confiável como "todos os canos morreram".
   */
  describe('pipe-pane auto-rearm (Story 2.10)', () => {
    function answer(text: string): void {
      const channelId = `${profileId}:${transport.opened.length}`;
      transport.feed(String(profileId), channelId, `${text}\n${QUERY_DELIMITER}\n`);
    }
    const pipeCmds = (): string[] =>
      transport.sent.map((s) => s.data).filter((d) => d.includes('pipe-pane'));

    /**
     * O comando de re-arme também passa por `runQuery` (canal curto + leitura
     * até o delimitador). Contra o tmux real o delimitador volta na hora; aqui
     * o fake precisa devolvê-lo, senão o await fica pendurado até o timeout.
     * `queueMicrotask` garante que a resposta chegue DEPOIS do await registrar.
     */
    function autoAnswerRearm(): void {
      const orig = transport.sendData.bind(transport);
      transport.sendData = (pid: string, channelId: string, data: string): void => {
        orig(pid, channelId, data);
        if (data.includes('pipe-pane')) {
          queueMicrotask(() => transport.feed(String(profileId), channelId, `${QUERY_DELIMITER}\n`));
        }
      };
    }

    it('AC2: pipe=0 é re-armado com reset close→open (NUNCA -o)', async () => {
      autoAnswerRearm();
      const mgr = makeManager();
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });
      const rearmed: string[] = [];
      mgr.on('pipeRearmed', ({ sessionName }) => rearmed.push(sessionName));

      const promise = mgr.rearmDeadPipes(String(profileId));
      answer('ckpt-a-claude-1 0');
      await promise;

      expect(rearmed).toEqual(['ckpt-a-claude-1']);
      const cmd = pipeCmds().join('\n');
      expect(cmd).toContain("tmux pipe-pane -t 'ckpt-a-claude-1';");
      expect(cmd).toContain("tmux pipe-pane -t 'ckpt-a-claude-1' 'cat >> ~/.cockpit/logs/ckpt-a-claude-1.log'");
      expect(cmd).not.toContain('pipe-pane -o');
    });

    it('pipe=1 não recebe comando algum', async () => {
      const mgr = makeManager();
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });
      const promise = mgr.rearmDeadPipes(String(profileId));
      answer('ckpt-a-claude-1 1');
      await promise;
      expect(pipeCmds()).toEqual([]);
    });

    it('AC1: consulta não confiável (timeout) NÃO dispara re-arme (SMK-004)', async () => {
      const { scheduler, cancel, runNext } = makeScheduler();
      const mgr = makeManager({ scheduler, cancelScheduler: cancel, queryTimeoutMs: 100 });
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });

      const promise = mgr.rearmDeadPipes(String(profileId));
      runNext(); // dispara o timeout sem nunca mandar o delimitador
      await promise;

      // O perigo é concluir "todos os canos morreram" e martelar as sessões.
      expect(pipeCmds()).toEqual([]);
    });

    it('sessão morta (status error) não é re-armada', async () => {
      const mgr = makeManager();
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'error' });
      await mgr.rearmDeadPipes(String(profileId));
      expect(pipeCmds()).toEqual([]);
    });

    it('AC4: desiste após N tentativas e emite pipeUnrecoverable', async () => {
      autoAnswerRearm();
      const mgr = makeManager({ maxPipeRearmAttempts: 2 });
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });
      const gaveUp: string[] = [];
      mgr.on('pipeUnrecoverable', ({ sessionName }) => gaveUp.push(sessionName));

      for (let i = 0; i < 4; i += 1) {
        const p = mgr.rearmDeadPipes(String(profileId));
        answer('ckpt-a-claude-1 0');
        await p;
      }

      expect(pipeCmds()).toHaveLength(2);
      expect(gaveUp).toEqual(['ckpt-a-claude-1']);
      expect(mgr.unrecoverablePipes(String(profileId))).toEqual(['ckpt-a-claude-1']);
    });

    it('AC4: cano que volta sozinho zera o contador (ganha ciclo novo)', async () => {
      autoAnswerRearm();
      const mgr = makeManager({ maxPipeRearmAttempts: 2 });
      metadata.create({ profileId, sessionName: 'ckpt-a-claude-1', status: 'active' });

      const p1 = mgr.rearmDeadPipes(String(profileId));
      answer('ckpt-a-claude-1 0');
      await p1;

      const p2 = mgr.rearmDeadPipes(String(profileId));
      answer('ckpt-a-claude-1 1');
      await p2;
      expect(mgr.unrecoverablePipes(String(profileId))).toEqual([]);

      const p3 = mgr.rearmDeadPipes(String(profileId));
      answer('ckpt-a-claude-1 0');
      await p3;
      expect(pipeCmds()).toHaveLength(2);
      expect(mgr.unrecoverablePipes(String(profileId))).toEqual([]);
    });

    it('AC3: rearmPipe recusa sessão não-ckpt antes de montar comando', async () => {
      const mgr = makeManager();
      await expect(mgr.rearmPipe(String(profileId), 'main')).rejects.toThrow(/non-ckpt/);
      expect(pipeCmds()).toEqual([]);
    });
  });
});

describe('parseSessionList (AC4)', () => {
  it('filters out non-ckpt names and tolerates malformed lines', () => {
    const out = 'ckpt-a-claude-1\r\nmain\n\n  ckpt-b-codex-2  \nsome random line with spaces\n';
    expect(parseSessionList(out)).toEqual(['ckpt-a-claude-1', 'ckpt-b-codex-2']);
  });

  it('returns empty for empty output', () => {
    expect(parseSessionList('')).toEqual([]);
    expect(parseSessionList('\n\n')).toEqual([]);
  });
});

describe('parsePipeStates (Story 2.10, AC1)', () => {
  it('lê nome + flag e ignora ruído/eco do comando', () => {
    const out = [
      'ckpt-a-claude-1 1',
      'main 0',
      'ckpt-b-codex-1 0',
      '#{session_name} #{pane_pipe}',
      'ckpt-c-claude-1 x',
      'ckpt-d-claude-1',
      '',
    ].join('\n');
    expect([...parsePipeStates(out)]).toEqual([
      ['ckpt-a-claude-1', true],
      ['ckpt-b-codex-1', false],
    ]);
  });

  it('sessão multi-pane conta como viva se QUALQUER pane tem pipe', () => {
    const out = 'ckpt-a-claude-1 0\nckpt-a-claude-1 1\nckpt-b-codex-1 0\nckpt-b-codex-1 0';
    const m = parsePipeStates(out);
    expect(m.get('ckpt-a-claude-1')).toBe(true);
    expect(m.get('ckpt-b-codex-1')).toBe(false);
  });
});

/**
 * Story 2.11 — cobertura de hooks (AC2/AC3/AC6).
 *
 * O contrato central é o mesmo que salvou a 2.9 do falso `unknown`: ausência de
 * DADO nunca vira alarme. Sem marcador legível, ninguém é acusado.
 */
describe('parseHookCoverage (Stories 2.11 + 2.12)', () => {
  const MARK = 1784634026; // 2026-07-21 08:40:26 — instalação real dos hooks

  it('separa "reciclar resolve" de "o agente não lê esses hooks"', () => {
    // O caso REAL de 2026-07-27: `ckpt-acme-claude-1` roda Codex apesar do
    // nome. O kind vem da cmdline, nunca do nome.
    const out = [
      `HOOK claude ${MARK} 1`,
      'HOOK codex - 0',
      `ckpt-globex-claude-1 ${MARK - 400000} claude`, // antes + claude → reciclar resolve
      `ckpt-acme-claude-1 ${MARK - 400000} codex`, // codex sem hook instalado → reciclar NÃO resolve
      `ckpt-northwind-claude-1 ${MARK + 120000} claude`, // depois → coberta
    ].join('\n');
    expect(parseHookCoverage(out)).toEqual({
      noHooks: ['ckpt-globex-claude-1'],
      unsupported: ['ckpt-acme-claude-1'],
    });
  });

  it('Codex sem configuração também é unsupported — não é questão de horário', () => {
    const out = ['HOOK codex - 0', `ckpt-a-claude-1 ${MARK + 999999} codex`].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: [], unsupported: ['ckpt-a-claude-1'] });
  });

  it('2.13: Codex com hook instalado deixa de ser unsupported; se iniciou antes do marcador vira noHooks', () => {
    const out = [
      `HOOK codex ${MARK} 1`,
      `ckpt-codex-old ${MARK - 1} codex`,
      `ckpt-codex-new ${MARK + 1} codex`,
    ].join('\n');
    expect(parseHookCoverage(out)).toEqual({
      noHooks: ['ckpt-codex-old'],
      unsupported: [],
    });
  });

  it('2.13: hook instalado sem marcador não vira alarme', () => {
    const out = ['HOOK codex - 1', `ckpt-codex-unknown ${MARK - 1} codex`].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: [], unsupported: [] });
  });

  it('AC6: sessão sem processo de agente (shell puro) é ignorada nas duas listas', () => {
    const out = [`HOOK claude ${MARK} 1`, 'ckpt-azure-claude-2 - -'].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: [], unsupported: [] });
  });

  it('sem marcador não acusa noHooks — mas agente sem hook instalado segue unsupported', () => {
    // Não ler o arquivo é fato do AGENTE, não do horário.
    const out = [
      'HOOK claude - 1',
      'HOOK codex - 0',
      `ckpt-acme-claude-1 ${MARK - 400000} claude`,
      `ckpt-b-claude-1 ${MARK - 400000} codex`,
    ].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: [], unsupported: ['ckpt-b-claude-1'] });
  });

  it('ignora não-ckpt, eco do comando e linhas malformadas', () => {
    const out = [
      `HOOK claude ${MARK} 1`,
      `main ${MARK - 999999} claude`,
      '#{session_name} #{pane_pid}',
      'ckpt-x-claude-1',
      `ckpt-y-claude-1 ${MARK - 1} claude`,
      '',
    ].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: ['ckpt-y-claude-1'], unsupported: [] });
  });

  it('borda: início exatamente no marcador conta como COM hooks', () => {
    const out = [`HOOK claude ${MARK} 1`, `ckpt-a-claude-1 ${MARK} claude`].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: [], unsupported: [] });
  });

  it('mantém fallback compatível com MARK global da 2.11/2.12 para Claude', () => {
    const out = [`MARK ${MARK}`, `ckpt-a-claude-1 ${MARK - 1} claude`].join('\n');
    expect(parseHookCoverage(out)).toEqual({ noHooks: ['ckpt-a-claude-1'], unsupported: [] });
  });
});
