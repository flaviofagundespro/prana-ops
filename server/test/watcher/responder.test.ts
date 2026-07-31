/**
 * DecisionResponder tests (Story 2.7, AC2–AC7): fake HostQueryRunner + fake
 * DecisionSource — nenhum SSH/tmux real. Cobrem os invariantes de segurança:
 * escaping adversarial (aspas, `;`, newline, unicode, prefixo '-'), allowlist
 * dura no server, gate high com token de uso único (reuso/expiração/troca de
 * texto falham), low direto, answered+auditoria, e falha honesta (sessão
 * morta não patcha nem remove da fila).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DecisionResponder,
  shellQuote,
  sanitizeResponseText,
  buildSendKeysCommand,
  type DecisionSource,
} from '../../src/watcher/responder.js';
import type { DecisionQueueItem } from '../../src/ws/protocol.js';

const SENT = '__CKPT_SENT_OK__';

function makeDecision(over: Partial<DecisionQueueItem> = {}): DecisionQueueItem {
  return {
    id: 3,
    sessionName: 'ckpt-prana-claude-1',
    summary: 'Aprovar?',
    risk: 'low',
    status: 'pending',
    updatedAt: '2026-07-16 12:00:00.000',
    ...over,
  };
}

function makeDeps(decision: DecisionQueueItem | undefined, sendOutput: string | null = SENT): {
  runner: { commands: string[]; runHostQuery: ReturnType<typeof vi.fn> };
  source: DecisionSource & { patches: Array<[string, number, string]> };
} {
  const commands: string[] = [];
  const runner = {
    commands,
    runHostQuery: vi.fn(async (_p: string, cmd: string) => {
      commands.push(cmd);
      // 1º comando = send-keys; demais (auditoria) devolvem ok genérico.
      return cmd.startsWith('tmux send-keys') ? sendOutput : '{"ok":true}';
    }),
  };
  const patches: Array<[string, number, string]> = [];
  const source = {
    patches,
    findDecision: () => decision,
    patchDecision: vi.fn(async (p: string, id: number, a: string) => {
      patches.push([p, id, a]);
      return true;
    }),
  };
  return { runner, source };
}

describe('shellQuote / sanitizeResponseText / buildSendKeysCommand (AC5)', () => {
  it('single-quote POSIX: apóstrofo é o único escape; shell metachars viram literais', () => {
    expect(shellQuote(`don't`)).toBe(`'don'\\''t'`);
    expect(shellQuote('a; rm -rf /')).toBe(`'a; rm -rf /'`);
    expect(shellQuote('$(reboot) `id` $HOME && echo x')).toBe("'$(reboot) `id` $HOME && echo x'");
  });

  it('newlines embutidos colapsam em espaço (Enter único); controle C0 removido', () => {
    expect(sanitizeResponseText('sim\ncontinua\r\nvai')).toBe('sim continua vai');
    expect(sanitizeResponseText('a\x1b[31mb\x07c')).toBe('a[31mbc');
    expect(sanitizeResponseText('  y  ')).toBe('y');
  });

  it('comando usa -l (literal), -- (fim de opções) e Enter como keystroke separado', () => {
    const cmd = buildSendKeysCommand('ckpt-a-claude-1', '-n --dry-run');
    expect(cmd).toBe(
      `tmux send-keys -l -t 'ckpt-a-claude-1' -- '-n --dry-run' && ` +
        `tmux send-keys -t 'ckpt-a-claude-1' Enter && echo ${SENT}`,
    );
  });

  it('casos adversariais ficam inertes dentro das aspas', () => {
    const evil = `'; tmux kill-server; echo '`;
    const cmd = buildSendKeysCommand('ckpt-a-claude-1', evil);
    // O payload aparece APENAS embrulhado — cada ' do atacante virou '\''.
    expect(cmd).toContain(`-- ''\\''; tmux kill-server; echo '\\'''`);
    // Unicode passa intacto.
    expect(buildSendKeysCommand('ckpt-a-claude-1', 'não, usa a versão 2 — ação ✅')).toContain(
      `'não, usa a versão 2 — ação ✅'`,
    );
  });

  it('recusa construir comando para sessão fora da allowlist (AC3)', () => {
    expect(() => buildSendKeysCommand('4terminal', 'y')).toThrow();
    expect(() => buildSendKeysCommand('Ckpt-x', 'y')).toThrow();
  });
});

describe('DecisionResponder (AC2–AC7)', () => {
  it('low responde direto: send-keys + answered + auditoria em events (AC4/AC6)', async () => {
    const { runner, source } = makeDeps(makeDecision({ risk: 'low' }));
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });

    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 3,
      sessionName: 'ckpt-prana-claude-1',
      text: 'y',
    });

    expect(outcome).toEqual({ kind: 'result', ok: true });
    expect(runner.commands[0]).toContain(`tmux send-keys -l -t 'ckpt-prana-claude-1' -- 'y'`);
    expect(source.patches).toEqual([['3', 3, 'answered']]);
    // Auditoria: POST /hook local com source respond (AC6).
    expect(runner.commands[1]).toContain('curl -s --max-time 3 -X POST http://127.0.0.1:4100/hook');
    expect(runner.commands[1]).toContain('respond');
  });

  it('high SEM token → challenge com comando exato; NADA é enviado (AC4)', async () => {
    const { runner, source } = makeDeps(makeDecision({ risk: 'high' }));
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });

    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 3,
      sessionName: 'ckpt-prana-claude-1',
      text: 'rm -rf ./build',
    });

    expect(outcome.kind).toBe('challenge');
    if (outcome.kind === 'challenge') {
      expect(outcome.command).toContain(`-- 'rm -rf ./build'`);
      expect(outcome.confirmToken.length).toBeGreaterThan(8);
    }
    expect(runner.commands).toEqual([]); // zero comandos na VPS
    expect(source.patches).toEqual([]);
  });

  it('high COM token válido envia; token é de USO ÚNICO (reuso → novo challenge, sem envio)', async () => {
    const { runner, source } = makeDeps(makeDecision({ risk: 'high' }));
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });
    const input = { profileId: '3', decisionId: 3, sessionName: 'ckpt-prana-claude-1', text: 'y' };

    const challenge = await responder.respond(input);
    if (challenge.kind !== 'challenge') throw new Error('esperava challenge');

    const sent = await responder.respond({ ...input, confirmToken: challenge.confirmToken });
    expect(sent).toEqual({ kind: 'result', ok: true });
    expect(runner.commands.filter((c) => c.startsWith('tmux send-keys'))).toHaveLength(1);

    // Reuso do MESMO token: não envia de novo — vira novo challenge.
    const reuse = await responder.respond({ ...input, confirmToken: challenge.confirmToken });
    expect(reuse.kind).toBe('challenge');
    expect(runner.commands.filter((c) => c.startsWith('tmux send-keys'))).toHaveLength(1);
  });

  it('token vinculado à resposta INTEIRA: texto trocado após o challenge não envia (AC4)', async () => {
    const { runner, source } = makeDeps(makeDecision({ risk: 'high' }));
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });
    const input = { profileId: '3', decisionId: 3, sessionName: 'ckpt-prana-claude-1', text: 'n' };

    const challenge = await responder.respond(input);
    if (challenge.kind !== 'challenge') throw new Error('esperava challenge');

    const swapped = await responder.respond({
      ...input,
      text: 'y',
      confirmToken: challenge.confirmToken,
    });
    expect(swapped.kind).toBe('challenge'); // texto mudou → challenge NOVO para o texto novo
    expect(runner.commands).toEqual([]);
  });

  it('token expirado não envia (TTL, relógio injetado)', async () => {
    let now = 1_000_000;
    const { runner, source } = makeDeps(makeDecision({ risk: 'high' }));
    const responder = new DecisionResponder({
      queryRunner: runner,
      decisions: source,
      tokenTtlMs: 60_000,
      nowMs: () => now,
    });
    const input = { profileId: '3', decisionId: 3, sessionName: 'ckpt-prana-claude-1', text: 'y' };

    const challenge = await responder.respond(input);
    if (challenge.kind !== 'challenge') throw new Error('esperava challenge');

    now += 61_000; // passou do TTL
    const expired = await responder.respond({ ...input, confirmToken: challenge.confirmToken });
    expect(expired.kind).toBe('challenge');
    expect(runner.commands).toEqual([]);
  });

  it('decisão FORA do snapshot = risco desconhecido = high (na dúvida, high) (AC4)', async () => {
    const { runner } = makeDeps(undefined);
    const source = {
      findDecision: () => undefined,
      patchDecision: vi.fn(async () => true),
    };
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });

    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 99,
      sessionName: 'ckpt-prana-claude-1',
      text: 'y',
    });
    expect(outcome.kind).toBe('challenge');
  });

  it('allowlist no server: sessão fora do prefixo é rejeitada E logada (AC3)', async () => {
    const { runner, source } = makeDeps(makeDecision());
    const onReject = vi.fn();
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source, onReject });

    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 3,
      sessionName: '4terminal',
      text: 'y',
    });

    expect(outcome).toEqual({ kind: 'result', ok: false, message: 'sessão fora da allowlist ckpt-' });
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: '4terminal', reason: 'fora da allowlist ckpt-' }),
    );
    expect(runner.commands).toEqual([]);
  });

  it('sessão morta/canal indisponível: erro claro, decisão FICA na fila, sem retry (AC7)', async () => {
    // Saída sem o marcador (stderr "can't find session") e timeout (null).
    for (const output of ["can't find session: ckpt-prana-claude-1", null]) {
      const { runner, source } = makeDeps(makeDecision({ risk: 'low' }), output);
      const responder = new DecisionResponder({ queryRunner: runner, decisions: source });

      const outcome = await responder.respond({
        profileId: '3',
        decisionId: 3,
        sessionName: 'ckpt-prana-claude-1',
        text: 'y',
      });

      expect(outcome.kind).toBe('result');
      if (outcome.kind === 'result') {
        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain('não confirmado');
      }
      expect(source.patches).toEqual([]); // NÃO vira answered
      // Só o send-keys foi tentado (1 comando) — sem retry, sem auditoria de sucesso.
      expect(runner.commands.filter((c) => c.startsWith('tmux send-keys'))).toHaveLength(1);
    }
  });

  it('falha do PATCH answered não desfaz o envio: ok:true com nota honesta (AC6)', async () => {
    const { runner } = makeDeps(makeDecision({ risk: 'low' }));
    const source = {
      findDecision: () => makeDecision({ risk: 'low' }),
      patchDecision: vi.fn(async () => false),
    };
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });

    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 3,
      sessionName: 'ckpt-prana-claude-1',
      text: 'y',
    });
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.ok).toBe(true);
      expect(outcome.message).toContain('PATCH answered falhou');
    }
  });

  it('resposta vazia (ou só whitespace/newlines) é recusada antes de qualquer comando', async () => {
    const { runner, source } = makeDeps(makeDecision({ risk: 'low' }));
    const responder = new DecisionResponder({ queryRunner: runner, decisions: source });
    const outcome = await responder.respond({
      profileId: '3',
      decisionId: 3,
      sessionName: 'ckpt-prana-claude-1',
      text: '\n\n  \r\n',
    });
    expect(outcome).toEqual({ kind: 'result', ok: false, message: 'resposta vazia' });
    expect(runner.commands).toEqual([]);
  });
});
