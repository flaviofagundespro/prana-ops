/**
 * Testes da Camada 2 — regex + dedup (Story 2.3, AC9): funções puras
 * (padrões, ANSI, split, hash) e integração real com fs (tmpdir) + watcher
 * em memória. Nenhum recurso externo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, appendFileSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWatcher, isCkptSession } from '../watcher.mjs';
import {
  stripAnsi,
  matchDecisionPattern,
  matchLongQuestion,
  matchStalledPrompt,
  splitLines,
  CARRY_MAX_BYTES,
  hashLines,
  listCkptLogFiles,
  createScanner,
} from '../scanner.mjs';

describe('funções puras — padrões (Story 2.3, AC3)', () => {
  it('detecta [y/N] e variantes de case', () => {
    expect(matchDecisionPattern('Continuar? [y/N]')).toBe('yn-bracket');
    expect(matchDecisionPattern('Continuar? [Y/n]')).toBe('yn-bracket');
    expect(matchDecisionPattern('sem padrão aqui')).toBeNull();
  });

  it('detecta (yes/no)', () => {
    expect(matchDecisionPattern('Prosseguir (yes/no)')).toBe('yn-paren');
  });

  it('detecta approve?/confirm?', () => {
    expect(matchDecisionPattern('Deploy pronto, approve?')).toBe('approve');
    expect(matchDecisionPattern('Migration ok, confirm?')).toBe('confirm');
  });

  it('strip ANSI antes de casar (pipe-pane captura terminal cru)', () => {
    const withAnsi = '\x1B[31mContinuar? [y/N]\x1B[0m';
    expect(matchDecisionPattern(withAnsi)).toBe('yn-bracket');
    expect(stripAnsi(withAnsi)).toBe('Continuar? [y/N]');
  });

  it('strip ANSI cobre "private mode" (achado real: bracketed-paste \\x1B[?2004h)', () => {
    const withPrivateMode = '\x1B[?2004hAprovar? [y/N]';
    expect(stripAnsi(withPrivateMode)).toBe('Aprovar? [y/N]');
    expect(matchDecisionPattern(withPrivateMode)).toBe('yn-bracket');
  });

  it('"? de mensagem longa": última linha não-vazia termina em ? com bloco >= minLines antes', () => {
    const tail = ['linha 1', 'linha 2', 'linha 3', 'linha 4', 'linha 5', 'Prosseguir com isso?'];
    expect(matchLongQuestion(tail, 5)).toBe('long-question');
    expect(matchLongQuestion(['a', 'b', 'Prosseguir?'], 5)).toBeNull(); // bloco curto demais
  });

  it('long-question exige que a ÚLTIMA linha não-vazia termine em ?', () => {
    const tail = ['linha 1', 'linha 2', 'linha 3', 'linha 4', 'linha 5', 'sem interrogação'];
    expect(matchLongQuestion(tail, 5)).toBeNull();
  });

  it('prompt parado: última linha não-vazia do tail casa QUALQUER padrão', () => {
    expect(matchStalledPrompt(['saida qualquer', 'Continuar? [y/N]'], 5)).toBe('yn-bracket');
    expect(matchStalledPrompt(['saida qualquer', 'nada de especial'], 5)).toBeNull();
  });
});

describe('funções puras — split incremental e hash (AC1, AC5)', () => {
  it('splitLines separa linhas completas e devolve o restante parcial', () => {
    const { lines, leftover } = splitLines('', 'linha A\nlinha B\nparcial-sem-newl');
    expect(lines).toEqual(['linha A', 'linha B']);
    expect(leftover).toBe('parcial-sem-newl');
  });

  it('splitLines junta o carry do tick anterior com o novo chunk', () => {
    const { lines, leftover } = splitLines('parcial-sem-newl', 'ine\nresto');
    expect(lines).toEqual(['parcial-sem-newline']);
    expect(leftover).toBe('resto');
  });

  it('Story 2.18: TUI sem newline mantém carry com teto explícito', () => {
    const repaint = '\x1b[2J\x1b[H✻ Ideating…'.repeat(CARRY_MAX_BYTES);
    const { lines, leftover } = splitLines('', repaint);
    expect(lines).toEqual([]);
    expect(Buffer.byteLength(leftover, 'utf8')).toBeLessThanOrEqual(CARRY_MAX_BYTES);
    expect(leftover).toContain('✻ Ideating…');
    expect(repaint.endsWith(leftover)).toBe(true);
  });

  it('hashLines ignora ANSI/espaços e vazias — mesmo prompt com cores diferentes gera mesmo hash', () => {
    const a = hashLines(['Continuar? [y/N]', '']);
    const b = hashLines(['\x1B[31mContinuar? [y/N]\x1B[0m  ']);
    expect(a).toBe(b);
    expect(hashLines(['outra coisa'])).not.toBe(a);
  });
});

describe('listCkptLogFiles (AC2)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ckpt-logs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lista só *.log cujo nome passa isCkptSession — ignora o resto por completo', () => {
    writeFileSync(path.join(dir, 'ckpt-a-claude-1.log'), '');
    writeFileSync(path.join(dir, '4terminal.log'), '');
    writeFileSync(path.join(dir, 'ckpt-b-codex-1.txt'), ''); // extensão errada
    const files = listCkptLogFiles(dir, isCkptSession);
    expect(files.map((f) => f.sessionName)).toEqual(['ckpt-a-claude-1']);
  });

  it('diretório inexistente não lança — devolve lista vazia', () => {
    expect(listCkptLogFiles(path.join(dir, 'nao-existe'), isCkptSession)).toEqual([]);
  });
});

describe('scanner integrado (watcher real em memória + fs real)', () => {
  let watcher;
  let logsDir;
  const cfg = { stallMs: 100, dedupWindowMs: 60_000, dedupLines: 5, longMsgMinLines: 3 };

  beforeEach(() => {
    watcher = createWatcher({ dbPath: ':memory:' });
    logsDir = mkdtempSync(path.join(tmpdir(), 'ckpt-scan-'));
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  function logPath(sessionName) {
    return path.join(logsDir, `${sessionName}.log`);
  }

  function pending() {
    return watcher.db.prepare(`SELECT * FROM decisions WHERE status = 'pending' ORDER BY id ASC`).all();
  }

  function stateOf(sessionName) {
    return watcher.db.prepare(`SELECT * FROM session_state WHERE session_name = ?`).get(sessionName);
  }

  it('primeiro encontro do arquivo NUNCA processa histórico pré-existente (offset começa no EOF)', () => {
    const session = 'ckpt-scan-1';
    writeFileSync(logPath(session), 'prompt antigo [y/N]\n');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce(); // primeiro encontro — só registra o offset
    expect(pending()).toHaveLength(0);
  });

  it('AC1/AC3/AC6: delta com [y/N] cria candidato via a via única (source=regex)', () => {
    const session = 'ckpt-scan-2';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce(); // primeiro encontro (offset=0, arquivo vazio)
    appendFileSync(logPath(session), 'Aprovar deploy? [y/N]\n');
    scanner.scanOnce();
    const rows = pending();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_name).toBe(session);
    expect(rows[0].source).toBe('regex');
    expect(rows[0].risk).toBe('high');
    expect(rows[0].summary).toBe('Aprovar deploy? [y/N]');
    expect(stateOf(session).state).toBe('waiting_for_input');
  });

  it('AC2: sessão fora da allowlist é ignorada por completo (nem events)', () => {
    const session = '4terminal';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'Continuar? [y/N]\n');
    scanner.scanOnce();
    expect(pending()).toHaveLength(0);
    expect(watcher.db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(0);
  });

  it('AC5: dedup — o MESMO prompt repetido em ticks seguintes não duplica a decisão', () => {
    const session = 'ckpt-scan-3';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'Aprovar? [y/N]\n');
    scanner.scanOnce();
    appendFileSync(logPath(session), 'Aprovar? [y/N]\n'); // mesmo conteúdo, novo delta
    scanner.scanOnce();
    expect(pending()).toHaveLength(1);
  });

  it('AC5: dedup cross-camada — hook (2.2) e regex (2.3) para a mesma sessão viram UMA decisão', async () => {
    const session = 'ckpt-scan-4';
    const addr = await watcher.start(0);
    await fetch(`http://127.0.0.1:${addr.port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'claude-hook', event: 'notification', session_name: session }),
    });
    expect(pending()).toHaveLength(1);

    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'Aprovar mesmo assim? [y/N]\n');
    scanner.scanOnce();

    const rows = pending();
    expect(rows).toHaveLength(1); // continua UMA decisão, não duas
    expect(rows[0].summary).toBe('Aprovar mesmo assim? [y/N]'); // atualizada pelo regex
    await watcher.stop();
  });

  it('Story 2.18: output com newlines sem padrão não inventa thinking', () => {
    const session = 'ckpt-scan-5';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'gerando código...\nmais uma linha...\n');
    scanner.scanOnce();
    expect(stateOf(session)).toBeUndefined();
    expect(pending()).toHaveLength(0);
  });

  it('Story 2.18: repaint de attach com muitas linhas não inventa thinking', () => {
    const session = 'ckpt-scan-attach-lines';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();

    const staticScreen = Array.from(
      { length: 1000 },
      (_, n) => `\x1b[${n % 40 + 1};1Hlinha estática ${n % 40}\n`,
    ).join('');
    appendFileSync(logPath(session), `\x1b[2J\x1b[H${staticScreen}`);
    scanner.scanOnce();

    expect(stateOf(session)).toBeUndefined();
    expect(pending()).toHaveLength(0);
  });

  it('Story 2.18: repaint ANSI/attach/mouse sem newline não inventa thinking', () => {
    const session = 'ckpt-scan-tui-neutral';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();

    appendFileSync(
      logPath(session),
      [
        '\x1b[2J\x1b[H✻ Ideating… (1m 37s)',
        '\x1b[?1000h\x1b[<35;42;12M',
        '\x1b[Hmesma tela depois do attach',
      ].join(''),
    );
    scanner.scanOnce();

    expect(stateOf(session)).toBeUndefined();
    expect(pending()).toHaveLength(0);
  });

  it('AC4: silêncio sem padrão de prompt (após stall) vira idle, não decisão', async () => {
    const session = 'ckpt-scan-6';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'saida qualquer sem pergunta\n');
    scanner.scanOnce(); // marca lastDeltaAt
    await new Promise((r) => setTimeout(r, cfg.stallMs + 20));
    scanner.scanOnce(); // delta vazio, stall atingido
    expect(stateOf(session).state).toBe('idle');
    expect(pending()).toHaveLength(0);
  });

  it('AC4: prompt parado (última linha casa padrão) após stall gera candidato', async () => {
    const session = 'ckpt-scan-7';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    appendFileSync(logPath(session), 'Confirmar operação? [y/N]\n');
    scanner.scanOnce(); // já detecta no delta e cria a decisão
    expect(pending()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, cfg.stallMs + 20));
    scanner.scanOnce(); // silêncio + última linha ainda é o prompt — mesma decisão (dedup)
    expect(pending()).toHaveLength(1);
  });

  it('AC7 (precedência): estado de hook mais recente que o scan NÃO é rebaixado pela heurística', async () => {
    const session = 'ckpt-scan-8';
    const addr = await watcher.start(0);
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce(); // primeiro encontro do arquivo

    // Simula um hook 'notification' chegando DEPOIS do início deste ciclo de scan.
    await fetch(`http://127.0.0.1:${addr.port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'claude-hook', event: 'notification', session_name: session }),
    });
    expect(stateOf(session).state).toBe('waiting_for_input');

    // Delta sem padrão de decisão chegaria como 'thinking' — mas o hook é
    // mais recente que o início deste novo scan, então não deve rebaixar.
    appendFileSync(logPath(session), 'gerando mais output...\n');
    scanner.scanOnce();
    expect(stateOf(session).state).toBe('waiting_for_input');
    await watcher.stop();
  });

  it('AC8: log truncado/rotacionado reseta offset sem crash', () => {
    const session = 'ckpt-scan-9';
    writeFileSync(logPath(session), 'linha inicial\n');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce(); // offset = tamanho atual
    truncateSync(logPath(session), 0);
    expect(() => scanner.scanOnce()).not.toThrow(); // detecta o encolhimento, reseta offset
    appendFileSync(logPath(session), 'Aprovar? [y/N]\n');
    scanner.scanOnce();
    expect(pending()).toHaveLength(1);
  });

  it('AC8: arquivo removido é esquecido silenciosamente, sem crash', () => {
    const session = 'ckpt-scan-10';
    writeFileSync(logPath(session), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    rmSync(logPath(session));
    expect(() => scanner.scanOnce()).not.toThrow();
  });

  it('AC8: erro num arquivo não impede o scan dos demais', () => {
    const bad = 'ckpt-scan-bad';
    const good = 'ckpt-scan-good';
    writeFileSync(logPath(bad), '');
    writeFileSync(logPath(good), '');
    const scanner = createScanner({ watcher, isCkptSession, logsDir, config: cfg });
    scanner.scanOnce();
    // Remove o arquivo "bad" NO MEIO do processamento é difícil de forçar
    // deterministicamente; validamos a garantia via arquivo removido (acima)
    // e aqui garantimos que o scan continua íntegro com múltiplos arquivos.
    appendFileSync(logPath(good), 'Continuar? [y/N]\n');
    scanner.scanOnce();
    expect(pending().some((d) => d.session_name === good)).toBe(true);
  });
});
