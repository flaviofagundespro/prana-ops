/**
 * WatcherPoller tests (Story 2.6, AC1/AC2/AC3/AC5/AC7): fake HostQueryRunner
 * (nenhum SSH real — mesmo padrão de mock da Fase 1) + scheduler injetado
 * (nenhum timer real). Cobrem: mapeamento snake_case→camelCase, curl rodando
 * NA VPS via canal (o comando nunca contém host remoto), degradação graciosa
 * com emissão só-na-transição, backoff exponencial, recuperação, PATCH
 * validado contra injeção e re-poll imediato pós-ação.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WatcherPoller,
  parseStateOutput,
  type HostQueryRunner,
  type WatcherSnapshot,
} from '../../src/watcher/poller.js';

const STATE_BODY = JSON.stringify({
  ok: true,
  decisions: [
    {
      id: 3,
      session_name: 'ckpt-prana-claude-1',
      summary: 'Aprovar deploy?',
      risk: 'high',
      state: 'waiting_for_input',
      status: 'pending',
      source: 'regex',
      created_at: '2026-07-16 12:00:00.000',
      notified_at: null,
    },
  ],
  sessions: [
    { session_name: 'ckpt-prana-claude-1', state: 'waiting_for_input', updated_at: '2026-07-16 12:00:00.000' },
    { session_name: 'ckpt-acme-claude-1', state: 'thinking', updated_at: '2026-07-16 11:59:00.000' },
  ],
});

/** Runner fake: grava comandos e devolve respostas programadas em fila. */
function makeRunner(responses: Array<string | null>): HostQueryRunner & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    runHostQuery: vi.fn(async (_profileId: string, cmd: string) => {
      commands.push(cmd);
      return responses.length > 0 ? (responses.shift() as string | null) : null;
    }),
  };
}

/** Scheduler manual: captura callbacks + delays; `fire()` dispara o próximo. */
function makeScheduler(): {
  scheduler: (fn: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  delays: number[];
  fire: () => Promise<void>;
  pendingCount: () => number;
} {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    delays,
    scheduler: (fn, ms) => {
      delays.push(ms);
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return entry;
    },
    cancel: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    fire: async () => {
      const entry = queue.shift();
      if (entry && !entry.cancelled) entry.fn();
      // Deixa o pollOnce disparado pelo timer assentar.
      await new Promise((r) => setTimeout(r, 0));
    },
    pendingCount: () => queue.filter((e) => !e.cancelled).length,
  };
}

describe('parseStateOutput (Story 2.6)', () => {
  it('mapeia snake_case do watcher para o contrato camelCase do app', () => {
    const parsed = parseStateOutput(STATE_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed?.decisions).toEqual([
      {
        id: 3,
        sessionName: 'ckpt-prana-claude-1',
        summary: 'Aprovar deploy?',
        risk: 'high',
        status: 'pending',
        updatedAt: '2026-07-16 12:00:00.000',
      },
    ]);
    expect(parsed?.states.map((s) => [s.sessionName, s.state])).toEqual([
      ['ckpt-prana-claude-1', 'waiting_for_input'],
      ['ckpt-acme-claude-1', 'thinking'],
    ]);
  });

  it('tolera ruído residual do canal em volta do JSON', () => {
    const parsed = parseStateOutput(`\r\n${STATE_BODY}\r\n`);
    expect(parsed?.decisions).toHaveLength(1);
  });

  it('saída vazia, não-JSON ou shape errado → null (watcher indisponível)', () => {
    expect(parseStateOutput('')).toBeNull();
    expect(parseStateOutput('curl: (7) Failed to connect')).toBeNull();
    expect(parseStateOutput('{"error":"not found"}')).toBeNull();
    expect(parseStateOutput('{"ok":true}')).toBeNull();
  });

  it('linhas inválidas são puladas; risk desconhecido vira high (na dúvida, high)', () => {
    const body = JSON.stringify({
      ok: true,
      decisions: [
        { id: 'x', status: 'pending' }, // id inválido — fora
        { id: 9, session_name: 'ckpt-a', summary: 's', risk: 'medium', status: 'seen', created_at: 't' },
        { id: 10, session_name: 'ckpt-b', summary: 's', risk: 'low', status: 'dismissed', created_at: 't' }, // status fora da fila — fora
      ],
      sessions: [{ session_name: 'ckpt-a', state: 'sleeping', updated_at: 't' }], // estado inválido — fora
    });
    const parsed = parseStateOutput(body);
    expect(parsed?.decisions).toEqual([
      { id: 9, sessionName: 'ckpt-a', summary: 's', risk: 'high', status: 'seen', updatedAt: 't' },
    ]);
    expect(parsed?.states).toEqual([]);
  });
});

describe('WatcherPoller (Story 2.6)', () => {
  it('poll roda o curl NA VPS via canal e emite snapshot com profileId (AC1, AC7)', async () => {
    const runner = makeRunner([STATE_BODY]);
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      watcherPort: 4100,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    const snapshots: WatcherSnapshot[] = [];
    poller.on('snapshot', (s) => snapshots.push(s));

    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0));

    // AC1: o alvo do curl é o loopback DA VPS — nunca um host remoto.
    expect(runner.commands[0]).toContain('curl -s --max-time 3 http://127.0.0.1:4100/state');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      profileId: '7',
      watcherAvailable: true,
    });
    expect(snapshots[0]?.decisions).toHaveLength(1);
    expect(snapshots[0]?.states).toHaveLength(2);
    expect(poller.lastSnapshots()).toHaveLength(1);
  });

  it('VPS sem watcher: 1 snapshot indisponível na TRANSIÇÃO, sem spam (AC3)', async () => {
    const runner = makeRunner(['', '', '']); // curl falha limpo = saída vazia
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    const snapshots: WatcherSnapshot[] = [];
    poller.on('snapshot', (s) => snapshots.push(s));

    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0));
    await sched.fire(); // tick 2 — também falha
    await sched.fire(); // tick 3 — também falha

    // Só a transição emite; os ticks seguintes em backoff ficam mudos.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      profileId: '7',
      watcherAvailable: false,
      decisions: [],
      states: [],
    });
  });

  it('backoff exponencial em falha, com teto; reset na recuperação (AC2)', async () => {
    const runner = makeRunner(['', '', '', STATE_BODY]);
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      intervalMs: 10_000,
      maxIntervalMs: 30_000,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0)); // falha 1
    await sched.fire(); // falha 2
    await sched.fire(); // falha 3
    await sched.fire(); // sucesso → reset

    // Delays re-armados após cada poll: 20s (2^1), 40s→teto 30s, 30s (teto), 10s (reset).
    expect(sched.delays).toEqual([20_000, 30_000, 30_000, 10_000]);
  });

  it('recuperação: watcher volta → snapshot disponível de novo (AC3)', async () => {
    const runner = makeRunner(['', STATE_BODY]);
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    const snapshots: WatcherSnapshot[] = [];
    poller.on('snapshot', (s) => snapshots.push(s));

    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0));
    await sched.fire();

    expect(snapshots.map((s) => s.watcherAvailable)).toEqual([false, true]);
    expect(snapshots[1]?.decisions).toHaveLength(1);
  });

  it('stopPolling cancela o timer e limpa o snapshot do perfil', async () => {
    const runner = makeRunner([STATE_BODY]);
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0));
    expect(sched.pendingCount()).toBe(1);

    poller.stopPolling('7');
    expect(sched.pendingCount()).toBe(0);
    expect(poller.lastSnapshots()).toEqual([]);
  });

  it('patchDecision aplica o PATCH e dispara re-poll imediato (AC5)', async () => {
    const patched = JSON.stringify({ id: 3, status: 'dismissed' });
    const runner = makeRunner([STATE_BODY, patched, STATE_BODY]);
    const sched = makeScheduler();
    const poller = new WatcherPoller({
      queryRunner: runner,
      scheduler: sched.scheduler,
      cancelScheduler: sched.cancel,
    });
    poller.startPolling('7');
    await new Promise((r) => setTimeout(r, 0));

    const ok = await poller.patchDecision('7', 3, 'dismissed');
    expect(ok).toBe(true);
    expect(runner.commands[1]).toContain('curl -s --max-time 3 -X PATCH http://127.0.0.1:4100/decisions/3');
    expect(runner.commands[1]).toContain('{"status":"dismissed"}');
    // Re-poll imediato: um terceiro comando /state foi disparado.
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.commands[2]).toContain('/state');
  });

  it('patchDecision rejeita id/action inválidos SEM tocar o canal (anti-injeção)', async () => {
    const runner = makeRunner([]);
    const poller = new WatcherPoller({ queryRunner: runner });

    expect(await poller.patchDecision('7', 3.5, 'seen')).toBe(false);
    expect(await poller.patchDecision('7', -1, 'seen')).toBe(false);
    expect(
      await poller.patchDecision('7', 3, 'answered; rm -rf /' as unknown as 'seen'),
    ).toBe(false);
    expect(runner.commands).toEqual([]);
  });

  it('patchDecision devolve false em timeout do canal ou resposta sem eco do status', async () => {
    const runner = makeRunner([null, JSON.stringify({ error: 'decision not found' })]);
    const poller = new WatcherPoller({ queryRunner: runner });

    expect(await poller.patchDecision('7', 3, 'seen')).toBe(false); // timeout ⇒ null
    expect(await poller.patchDecision('7', 3, 'seen')).toBe(false); // 404 do watcher
  });
});
