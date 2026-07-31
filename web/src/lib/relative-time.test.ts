/**
 * relative-time tests (Story 2.6, AC5). Funções puras com relógio injetado —
 * determinísticas, sem timers reais. O formato de entrada é o strftime UTC do
 * watcher ('YYYY-MM-DD HH:MM:SS.mmm').
 */
import { describe, it, expect } from 'vitest';
import { parseWatcherTimestamp, relativeTime } from './relative-time.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

describe('parseWatcherTimestamp', () => {
  it('interpreta o formato do watcher como UTC', () => {
    expect(parseWatcherTimestamp('2026-07-16 12:00:00.000')).toBe(NOW);
  });

  it('entrada inválida ou vazia → null (nunca lança)', () => {
    expect(parseWatcherTimestamp('')).toBeNull();
    expect(parseWatcherTimestamp('não é data')).toBeNull();
  });
});

describe('relativeTime (rotulado "atualizado há X" pelo chamador — DOC-002)', () => {
  it('segundos, minutos, horas e dias', () => {
    expect(relativeTime('2026-07-16 11:59:28.000', NOW)).toBe('32s');
    expect(relativeTime('2026-07-16 11:55:00.000', NOW)).toBe('5min');
    expect(relativeTime('2026-07-16 09:00:00.000', NOW)).toBe('3h');
    expect(relativeTime('2026-07-14 11:00:00.000', NOW)).toBe('2d');
  });

  it('timestamp no futuro (clock skew) não fica negativo', () => {
    expect(relativeTime('2026-07-16 12:00:05.000', NOW)).toBe('0s');
  });

  it('timestamp inválido → string vazia', () => {
    expect(relativeTime('lixo', NOW)).toBe('');
  });
});
