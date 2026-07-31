/**
 * Story 2.9 — derivação de cobertura (AC4, AC5, AC7).
 *
 * O contrato testado é o da HONESTIDADE: ausência de sinal nunca pode ser
 * convertida em afirmação de calma, e ausência de DADO (watcher não migrado)
 * nunca pode virar alarme.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveCoverage,
  describeCoverage,
  parseWatcherTime,
  STUCK_THINKING_MS,
  type CoverageInput,
} from './session-coverage.js';
import type { SessionStateItem } from '../ws-protocol.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');

/** Timestamp no formato do watcher, N ms atrás. */
function watcherTimeAgo(ms: number): string {
  return new Date(NOW - ms).toISOString().replace('T', ' ').replace('Z', '');
}

function item(over: Partial<SessionStateItem> = {}): SessionStateItem {
  return {
    sessionName: 'ckpt-prana-claude-1',
    state: 'idle',
    updatedAt: watcherTimeAgo(1000),
    ...over,
  };
}

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    cacheStatus: 'active',
    watcherAvailable: true,
    stateItem: item(),
    nowMs: NOW,
    ...over,
  };
}

describe('deriveCoverage (AC4)', () => {
  it('sessão vigiada e calma → covered', () => {
    expect(deriveCoverage(input())).toBe('covered');
  });

  it('perfil sem watcher → no_watcher (nada daquela VPS está vigiado)', () => {
    expect(deriveCoverage(input({ watcherAvailable: false }))).toBe('no_watcher');
  });

  it('watcher no ar mas sem conhecer a sessão → unknown', () => {
    expect(deriveCoverage(input({ stateItem: undefined }))).toBe('unknown');
  });

  it('watcher ainda não reportado (undefined) não vira alarme, nem sem item', () => {
    // undefined = "nunca reportou", diferente de false = "reportou indisponível".
    // A combinação perigosa é undefined + sem item: é o estado do primeiro
    // render, antes do primeiro sync — alarmar aí marcaria TUDO como sem sinal.
    expect(deriveCoverage(input({ watcherAvailable: undefined }))).toBe('covered');
    expect(deriveCoverage(input({ watcherAvailable: undefined, stateItem: undefined }))).toBe(
      'covered',
    );
  });

  it('2.10/AC5: cano irrecuperável → no_pipe, com motivo acionável', () => {
    const { coverage, reason } = describeCoverage(input({ pipeUnrecoverable: true }));
    expect(coverage).toBe('no_pipe');
    expect(reason).toContain('re-armar');
  });

  it('2.10: enquanto o cockpit ainda está curando, NÃO alarma', () => {
    // pipeUnrecoverable ausente/false = ou o cano está bom, ou o re-arme está
    // em andamento. Alarmar aqui seria ruído sobre algo que some em ~10s.
    expect(deriveCoverage(input({ pipeUnrecoverable: false }))).toBe('covered');
    expect(deriveCoverage(input())).toBe('covered');
  });

  it('2.10: no_pipe vence unknown — é a EXPLICAÇÃO de por que não se conhece', () => {
    expect(deriveCoverage(input({ pipeUnrecoverable: true, stateItem: undefined }))).toBe('no_pipe');
  });

  it('2.11: agente iniciado antes dos hooks → no_hooks, com o custo da cura no motivo', () => {
    const { coverage, reason } = describeCoverage(input({ agentWithoutHooks: true }));
    expect(coverage).toBe('no_hooks');
    // Story 2.12: o texto deixou de dramatizar a perda — encerrar conversa é
    // higiene no fluxo do operador, e ambos os agentes retomam com --resume.
    expect(reason).toContain('reciclar a sessão ativa');
    expect(reason).toContain('--resume');
  });

  it('2.12: agente que não lê os hooks → hooks_unsupported, e o conselho é OPOSTO', () => {
    const { coverage, reason } = describeCoverage(input({ hooksUnsupported: true }));
    expect(coverage).toBe('hooks_unsupported');
    // O ponto da separação: aqui reciclar NÃO resolve.
    expect(reason).toContain('reciclar não resolve');
  });

  it('2.12: no_hooks e hooks_unsupported nunca se confundem no conselho', () => {
    const recyclable = describeCoverage(input({ agentWithoutHooks: true })).reason ?? '';
    const unsupported = describeCoverage(input({ hooksUnsupported: true })).reason ?? '';
    expect(recyclable).toContain('reciclar a sessão ativa');
    expect(unsupported).toContain('não resolve');
  });

  it('2.11/AC5: precedência — no_pipe vence no_hooks (sem cano, o cano é o problema maior)', () => {
    expect(
      deriveCoverage(input({ pipeUnrecoverable: true, agentWithoutHooks: true })),
    ).toBe('no_pipe');
  });

  it('2.11/AC5: no_hooks vence unknown e stuck (explica ambos)', () => {
    expect(deriveCoverage(input({ agentWithoutHooks: true, stateItem: undefined }))).toBe(
      'no_hooks',
    );
    const frozen = item({ state: 'thinking', stateSince: watcherTimeAgo(5 * 60 * 60 * 1000) });
    expect(deriveCoverage(input({ agentWithoutHooks: true, stateItem: frozen }))).toBe('no_hooks');
  });

  it('2.11/AC3: sem informação de hooks NÃO alarma', () => {
    expect(deriveCoverage(input({ agentWithoutHooks: false }))).toBe('covered');
    expect(deriveCoverage(input())).toBe('covered');
  });

  it('AC5: sessão morta (cache error) vence a cobertura — é erro, não ausência', () => {
    expect(
      deriveCoverage(input({ cacheStatus: 'error', watcherAvailable: false, stateItem: undefined })),
    ).toBe('covered');
  });
});

describe('deriveCoverage — thinking congelado (o caso 2026-07-21)', () => {
  it('thinking recente é trabalho normal, não alarme', () => {
    const stateItem = item({ state: 'thinking', stateSince: watcherTimeAgo(60_000) });
    expect(deriveCoverage(input({ stateItem }))).toBe('covered');
  });

  it('thinking além do limiar → stuck', () => {
    const stateItem = item({ state: 'thinking', stateSince: watcherTimeAgo(3 * 60 * 60 * 1000) });
    expect(deriveCoverage(input({ stateItem }))).toBe('stuck');
  });

  it.each([
    ['logo abaixo do limiar', STUCK_THINKING_MS - 1000, 'covered'],
    ['exatamente no limiar', STUCK_THINKING_MS, 'stuck'],
  ])('borda do limiar: %s → %s', (_label, age, expected) => {
    const stateItem = item({ state: 'thinking', stateSince: watcherTimeAgo(age) });
    expect(deriveCoverage(input({ stateItem }))).toBe(expected);
  });

  it('só `thinking` vira stuck — idle antigo é sessão parada, não cegueira', () => {
    const stateItem = item({ state: 'idle', stateSince: watcherTimeAgo(5 * 60 * 60 * 1000) });
    expect(deriveCoverage(input({ stateItem }))).toBe('covered');
  });

  it('waiting_for_input antigo NÃO vira stuck — o sinal já chegou, é a dor sendo mostrada', () => {
    const stateItem = item({
      state: 'waiting_for_input',
      stateSince: watcherTimeAgo(5 * 60 * 60 * 1000),
    });
    expect(deriveCoverage(input({ stateItem }))).toBe('covered');
  });

  it('AC1/AC3: sem stateSince (watcher não migrado) NUNCA vira stuck', () => {
    // Ausência de dado é desconhecimento, não "há muito tempo" — senão todas as
    // sessões viravam alarme no primeiro boot pós-deploy.
    const stateItem = item({ state: 'thinking', stateSince: undefined });
    expect(deriveCoverage(input({ stateItem }))).toBe('covered');
  });

  it('stateSince ilegível é tratado como ausente, não como época zero', () => {
    const stateItem = item({ state: 'thinking', stateSince: 'nao-e-uma-data' });
    expect(deriveCoverage(input({ stateItem }))).toBe('covered');
  });

  it('limiar é sobrescrevível (AC7 — configurável num lugar só)', () => {
    const stateItem = item({ state: 'thinking', stateSince: watcherTimeAgo(90_000) });
    expect(deriveCoverage(input({ stateItem, stuckThresholdMs: 60_000 }))).toBe('stuck');
  });
});

describe('parseWatcherTime', () => {
  it('lê o formato do watcher como UTC', () => {
    expect(parseWatcherTime('2026-07-27 12:00:00.000')).toBe(Date.parse('2026-07-27T12:00:00Z'));
  });

  it.each([undefined, '', 'lixo'])('entrada inválida (%s) → undefined', (value) => {
    expect(parseWatcherTime(value as string | undefined)).toBeUndefined();
  });
});

describe('describeCoverage — motivo legível (AC6)', () => {
  it('covered não tem motivo (nada a explicar)', () => {
    expect(describeCoverage(input()).reason).toBeUndefined();
  });

  it('cada ausência explica a si mesma em português', () => {
    expect(describeCoverage(input({ watcherAvailable: false })).reason).toContain('sem watcher');
    expect(describeCoverage(input({ stateItem: undefined })).reason).toContain('não conhece');
  });

  it('stuck informa há quanto tempo e SUGERE, sem afirmar que travou', () => {
    const stateItem = item({ state: 'thinking', stateSince: watcherTimeAgo(3 * 60 * 60 * 1000) });
    const { reason } = describeCoverage(input({ stateItem }));
    expect(reason).toContain('3h');
    expect(reason).toContain('pode estar');
  });
});
