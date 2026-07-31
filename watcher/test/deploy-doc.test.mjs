/**
 * O DEPLOY.md tem que copiar TUDO que o watcher importa (2026-07-30).
 *
 * Por que isto existe: `watcher.mjs` nasceu como arquivo único na Story 2.1 e o
 * DEPLOY.md mandava copiar só ele. As Camadas 2/3 e o Telegram viraram módulos
 * (`scanner.mjs`, `classifier.mjs`, `telegram.mjs`) e o comando de cópia nunca
 * foi atualizado. Resultado: todo deploy LIMPO terminava em
 * `ERR_MODULE_NOT_FOUND`, e ninguém percebeu por duas semanas porque a única
 * VPS instalada já tinha os módulos de cópias manuais anteriores — o defeito
 * era invisível exatamente para quem podia notá-lo.
 *
 * Documentação não tem compilador. Este teste é o compilador dela: é uma
 * verificação de sincronia, não de estilo, e falha no CI antes de falhar na VPS.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const watcherDir = path.resolve(here, '..');

/** Imports relativos de um módulo ESM: `import ... from './x.mjs'`. */
function localImports(file) {
  const src = fs.readFileSync(path.join(watcherDir, file), 'utf8');
  return [...src.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)].map((m) => m[1]);
}

/** Fecho transitivo dos imports locais a partir de watcher.mjs. */
function runtimeModules() {
  const seen = new Set(['watcher.mjs']);
  const queue = ['watcher.mjs'];
  while (queue.length > 0) {
    for (const dep of localImports(queue.pop())) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen];
}

describe('DEPLOY.md acompanha os módulos de runtime', () => {
  const deploy = fs.readFileSync(path.join(watcherDir, 'DEPLOY.md'), 'utf8');
  const modules = runtimeModules();

  it('descobre mais de um módulo (o teste seria vazio e inútil se não)', () => {
    expect(modules.length).toBeGreaterThan(1);
    expect(modules).toContain('watcher.mjs');
  });

  it.each(runtimeModules())('DEPLOY.md copia %s para a VPS', (mod) => {
    // Basta aparecer num comando de cópia — scp/rsync, uma linha ou várias.
    const copiado = new RegExp(`(scp|rsync)[^\\n]*(\\\\\\n[^\\n]*)*watcher/${mod.replace('.', '\\.')}`, 'm');
    expect(deploy).toMatch(copiado);
  });

  it('todo módulo importado existe em disco', () => {
    for (const mod of modules) {
      expect(fs.existsSync(path.join(watcherDir, mod))).toBe(true);
    }
  });
});
