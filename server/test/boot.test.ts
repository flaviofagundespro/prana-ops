/**
 * Story 2.16 — o boot para de mentir.
 *
 * Dois fatos, ambos verificados contra o processo REAL (o entrypoint só existe
 * como processo: `start()` roda no import), em porta efêmera — nunca a 4000 de
 * produção:
 *
 *   1. Boot saudável imprime a confirmação do HTTP e NÃO grava `[fatal]`.
 *   2. Segunda instância na mesma porta diz "already in use" e MORRE — em vez
 *      de ficar viva pela rede do `uncaughtException`, servindo nada.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const ENTRYPOINT = path.join('server', 'src', 'index.ts');
const BOOT_TIMEOUT_MS = 30_000;

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Porta livre no momento da chamada — jamais a 4000 do cockpit em uso. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** DB próprio por instância: o boot não pode tocar o `cockpit.db` real. */
function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-boot-'));
  tempDirs.push(dir);
  return path.join(dir, 'cockpit.db');
}

interface BootResult {
  output: string;
  exitCode: number | null;
  child: ChildProcess;
}

/**
 * Sobe o entrypoint e resolve quando `until` casar na saída ou quando o
 * processo morrer — o que vier primeiro. Sem `until`, espera a morte.
 */
function boot(port: number, until?: RegExp): Promise<BootResult> {
  const child = spawn(TSX, [ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), COCKPIT_DB_PATH: tempDbPath() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);

  return new Promise<BootResult>((resolve, reject) => {
    let output = '';
    const settle = (): void => {
      clearTimeout(timer);
      resolve({ output, exitCode: child.exitCode, child });
    };
    const timer = setTimeout(() => {
      reject(new Error(`boot timeout na porta ${port}. Saída até aqui:\n${output}`));
    }, BOOT_TIMEOUT_MS);

    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (until?.test(output)) settle();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', settle);
  });
}

describe('boot do servidor (Story 2.16)', () => {
  it('AC2/AC3: boot saudável confirma o HTTP e não grava erro fatal', async () => {
    const port = await freePort();
    const { output, exitCode } = await boot(port, /\[http\] Prana OPS listening/);

    // AC3 — é esta linha que permite afirmar "está no ar" pelo log.
    expect(output).toMatch(/\[http\] Prana OPS listening on http:\/\/localhost:/);
    // AC2 — nada de `[fatal]` num boot que deu certo.
    expect(output).not.toContain('[fatal]');
    expect(output).not.toContain('EADDRINUSE');
    // Segue vivo: quem resolveu foi o regex, não a morte do processo.
    expect(exitCode).toBeNull();
  });

  it('AC4: segunda instância na mesma porta avisa e ENCERRA', async () => {
    const port = await freePort();
    await boot(port, /\[http\] Prana OPS listening/);

    const { output, exitCode } = await boot(port);

    expect(output).toContain(`port ${port} is already in use`);
    expect(exitCode).toBe(1);
    // O que a 2.16 existe para matar: um cockpit fantasma, vivo e inútil,
    // deixando `[fatal]` no log de quem for diagnosticar depois.
    expect(output).not.toContain('mantendo o processo vivo');
  }, 60_000);
});
