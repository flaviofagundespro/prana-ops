/**
 * Preferência de VPS persistida (2026-07-15): a última VPS selecionada na
 * sidebar vira o default — da sidebar E do form de criar sessão — nas visitas
 * seguintes. Sem hardcode de nome: o default acompanha o uso do operador.
 * localStorage indisponível (SSR/teste estranho) degrada para "sem preferência".
 */
const KEY = 'pranaops:selected-profile';

export function getPreferredProfileId(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setPreferredProfileId(profileId: string): void {
  try {
    window.localStorage.setItem(KEY, profileId);
  } catch {
    // best-effort: preferência é conveniência, nunca erro.
  }
}
