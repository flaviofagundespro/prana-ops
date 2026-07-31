/**
 * Testes da Camada 1 — hooks nativos (Story 2.2, AC9): DB :memory:, porta
 * efêmera, fetch real contra o servidor. Cobrem o mapeamento evento→estado, a
 * síntese de candidato via `notification` com idempotência (AC7), `stop` sem
 * criar decisão, e a execução real do script `ckpt-hook.sh` contra um watcher
 * de verdade (tmux mockado via PATH).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWatcher, hookSummary } from '../watcher.mjs';

/**
 * Roda o script de forma ASSÍNCRONA (`spawn`, não `execFileSync`): o watcher
 * de teste roda no MESMO processo Node, e uma chamada síncrona travaria o
 * event loop — o servidor HTTP nunca processaria o POST do script até o
 * child terminar (deadlock só de teste; em produção script e daemon são
 * processos OS distintos). `stdin` é sempre fechado explicitamente (com ou
 * sem dado) para que `head -c` do script veja EOF na hora, nunca pendure.
 */
function runHook(scriptPath, args, { env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

let watcher;
let baseUrl;
let port;

beforeEach(async () => {
  watcher = createWatcher({ dbPath: ':memory:' });
  const addr = await watcher.start(0);
  port = addr.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await watcher.stop();
});

async function postHook(payload) {
  const res = await fetch(`${baseUrl}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function pendingDecisions() {
  return (await (await fetch(`${baseUrl}/decisions?status=pending`)).json());
}

describe('mapeamento evento→estado (Story 2.2, AC5)', () => {
  it('event=notification vira waiting_for_input', async () => {
    await postHook({ source: 'claude-hook', event: 'notification', session_name: 'ckpt-h-claude-1' });
    const st = watcher.db
      .prepare('SELECT state FROM session_state WHERE session_name = ?')
      .get('ckpt-h-claude-1');
    expect(st.state).toBe('waiting_for_input');
  });

  it('event=permission_request vira waiting_for_input', async () => {
    await postHook({ source: 'codex-hook', event: 'permission_request', session_name: 'ckpt-h-codex-1' });
    const st = watcher.db
      .prepare('SELECT state FROM session_state WHERE session_name = ?')
      .get('ckpt-h-codex-1');
    expect(st.state).toBe('waiting_for_input');
  });

  it('event=stop vira idle e NÃO cria decisão', async () => {
    await postHook({ source: 'claude-hook', event: 'stop', session_name: 'ckpt-h-claude-1' });
    const st = watcher.db
      .prepare('SELECT state FROM session_state WHERE session_name = ?')
      .get('ckpt-h-claude-1');
    expect(st.state).toBe('idle');
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c).toBe(0);
  });

  it('sessão fora da allowlist ignora o evento por completo (AC2)', async () => {
    const { body } = await postHook({ source: 'claude-hook', event: 'notification', session_name: '4terminal' });
    expect(body.allowed).toBe(false);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM session_state').get().c).toBe(0);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c).toBe(0);
  });
});

describe('candidato a decisão via hook (Story 2.2, AC6/AC7)', () => {
  it('notification sem raw usa o placeholder e risk=high', async () => {
    const { body } = await postHook({
      source: 'claude-hook',
      event: 'notification',
      session_name: 'ckpt-h-claude-2',
    });
    expect(body.decisionId).toBeGreaterThan(0);
    const [d] = await pendingDecisions();
    expect(d.summary).toBe('[hook] aguardando input');
    expect(d.risk).toBe('high');
    expect(d.source).toBe('claude-hook');
  });

  it('permission_request também cria candidato pela via única', async () => {
    const { body } = await postHook({
      source: 'codex-hook',
      event: 'permission_request',
      session_name: 'ckpt-h-codex-2',
    });
    expect(body.decisionId).toBeGreaterThan(0);
    const [d] = await pendingDecisions();
    expect(d.summary).toBe('[hook] aguardando input');
    expect(d.risk).toBe('high');
    expect(d.source).toBe('codex-hook');
  });

  it('notification com raw usa o texto bruto truncado como summary', async () => {
    await postHook({
      source: 'claude-hook',
      event: 'notification',
      session_name: 'ckpt-h-claude-3',
      raw: 'Aprovar deploy em produção?',
    });
    const [d] = await pendingDecisions();
    expect(d.summary).toBe('Aprovar deploy em produção?');
  });

  it('idempotência: notification repetida NÃO duplica decisão pendente (AC7)', async () => {
    const first = await postHook({
      source: 'claude-hook',
      event: 'notification',
      session_name: 'ckpt-h-claude-4',
      raw: 'primeira pergunta',
    });
    const second = await postHook({
      source: 'claude-hook',
      event: 'notification',
      session_name: 'ckpt-h-claude-4',
      raw: 'segunda pergunta (mesmo momento)',
    });
    expect(second.body.decisionId).toBe(first.body.decisionId);
    const rows = await pendingDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('segunda pergunta (mesmo momento)');
  });

  it('decisão de OUTRA sessão não interfere na idempotência', async () => {
    await postHook({ source: 'claude-hook', event: 'notification', session_name: 'ckpt-h-claude-5' });
    await postHook({ source: 'claude-hook', event: 'notification', session_name: 'ckpt-h-claude-6' });
    const rows = await pendingDecisions();
    expect(rows).toHaveLength(2);
  });

  it('decisão explícita (objeto decision) tem precedência sobre a síntese de hook', async () => {
    const { body } = await postHook({
      source: 'claude-hook',
      event: 'notification',
      session_name: 'ckpt-h-claude-7',
      decision: { summary: 'decisão explícita', risk: 'low' },
    });
    const [d] = await pendingDecisions();
    expect(d.id).toBe(body.decisionId);
    expect(d.summary).toBe('decisão explícita');
    expect(d.risk).toBe('low');
  });
});

describe('resumo legível a partir do payload do hook (Story 2.13/AC2)', () => {
  it('Codex: prefere tool_input.description, a pergunta escrita para humano', () => {
    const raw = JSON.stringify({
      session_id: '019faa73',
      transcript_path: '/home/ubuntu/.codex/sessions/x.jsonl',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'touch /etc/probe',
        description: 'Posso criar exatamente o arquivo /etc/probe solicitado?',
      },
    });
    expect(hookSummary(raw)).toBe('Posso criar exatamente o arquivo /etc/probe solicitado?');
  });

  it('Codex sem descrição: cai para tool_name + primeira linha do comando', () => {
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x\necho segunda linha' },
    });
    expect(hookSummary(raw)).toBe('Bash: rm -rf /tmp/x');
  });

  it('Claude Code: usa message', () => {
    expect(hookSummary(JSON.stringify({ message: 'Claude precisa da sua permissão' }))).toBe(
      'Claude precisa da sua permissão',
    );
  });

  it('JSON truncado NUNCA vira despejo de payload — vai para o placeholder', () => {
    // O ckpt-hook.sh corta o stdin em 2000 B; JSON grande chega partido ao meio.
    const truncated = '{"session_id":"019faa73-b3f1-77c3-90ff-5484d5d40681","transcript_pa';
    expect(hookSummary(truncated)).toBe('[hook] aguardando input');
  });

  it('JSON válido sem nenhum campo aproveitável também vai para o placeholder', () => {
    expect(hookSummary(JSON.stringify({ session_id: 'x', turn_id: 'y' }))).toBe(
      '[hook] aguardando input',
    );
  });

  it('texto simples (não-JSON) continua passando direto, truncado em 200', () => {
    expect(hookSummary('Aprovar deploy?')).toBe('Aprovar deploy?');
    expect(hookSummary('a'.repeat(300))).toHaveLength(200);
  });

  it('vazio ou não-string vira placeholder', () => {
    expect(hookSummary('')).toBe('[hook] aguardando input');
    expect(hookSummary(undefined)).toBe('[hook] aguardando input');
    expect(hookSummary(null)).toBe('[hook] aguardando input');
  });

  it('ponta a ponta: permission_request do Codex grava o resumo legível', async () => {
    const { body } = await postHook({
      source: 'codex-hook',
      event: 'permission_request',
      session_name: 'ckpt-h-codex-3',
      raw: JSON.stringify({
        session_id: '019faa73',
        tool_name: 'Bash',
        tool_input: { command: 'touch /etc/probe', description: 'Posso criar /etc/probe?' },
      }),
    });
    expect(body.decisionId).toBeGreaterThan(0);
    const [d] = await pendingDecisions();
    expect(d.summary).toBe('Posso criar /etc/probe?');
    expect(d.risk).toBe('high');
  });
});

describe('script ckpt-hook.sh (execução real, tmux mockado)', () => {
  let binDir;
  let scriptPath;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(tmpdir(), 'ckpt-hook-bin-'));
    const fakeTmux = `#!/bin/sh\necho "ckpt-shellhook-claude-1"\n`;
    writeFileSync(path.join(binDir, 'tmux'), fakeTmux);
    chmodSync(path.join(binDir, 'tmux'), 0o755);
    scriptPath = path.resolve('hooks/ckpt-hook.sh');
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('notification real via script cria candidato no watcher', async () => {
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, WATCHER_PORT: String(port) };
    await runHook(scriptPath, ['notification', 'claude-hook'], { env, input: 'payload nativo do hook\n' });
    const rows = await pendingDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_name).toBe('ckpt-shellhook-claude-1');
    expect(rows[0].summary).toBe('payload nativo do hook');
  });

  it('sem sessão tmux (tmux falha) o script sai silenciosamente, sem POST', async () => {
    const noTmuxDir = mkdtempSync(path.join(tmpdir(), 'ckpt-hook-notmux-'));
    try {
      const env = { ...process.env, PATH: noTmuxDir, WATCHER_PORT: String(port) };
      await runHook(scriptPath, ['notification', 'claude-hook'], { env });
      const rows = await pendingDecisions();
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(noTmuxDir, { recursive: true, force: true });
    }
  });

  it('watcher fora do ar não trava o script (curl falha silenciosamente, AC1)', async () => {
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, WATCHER_PORT: '1' };
    const { code } = await runHook(scriptPath, ['notification', 'claude-hook'], { env });
    expect(code).toBe(0);
  });
});
