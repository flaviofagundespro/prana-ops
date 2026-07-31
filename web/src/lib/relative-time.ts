/**
 * Timestamp relativo curto para a fila de decisões (Story 2.6, AC5).
 *
 * O instante vem do watcher como texto UTC `YYYY-MM-DD HH:MM:SS.mmm`
 * (strftime do SQLite) e é SEMPRE "última atualização" — o `created_at` do
 * watcher é reaproveitado pelos touches do regex/classificador (DOC-002 do
 * gate 2.5) — então quem exibe rotula "atualizado há X", nunca "criado há X".
 * Funções puras com `nowMs` injetável (determinísticas nos testes).
 */

/** Converte o timestamp UTC do watcher em epoch ms; formato inválido → null. */
export function parseWatcherTimestamp(ts: string): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const ms = Date.parse(`${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** "32s" / "5min" / "3h" / "2d" — vazio se o timestamp for inválido. */
export function relativeTime(ts: string, nowMs: number = Date.now()): string {
  const ms = parseWatcherTimestamp(ts);
  if (ms === null) return '';
  const seconds = Math.floor(Math.max(0, nowMs - ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
