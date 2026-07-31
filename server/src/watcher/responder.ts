/**
 * DecisionResponder — responde uma decisão injetando texto na sessão tmux via
 * `send-keys` no canal de controle SSH (Story 2.7, AC1–AC7).
 *
 * INVARIANTES DE SEGURANÇA (todos NO SERVER — a UI é conveniência, o server é
 * o invariante, mesma filosofia do bind 127.0.0.1 da 2.1):
 *
 *  1. ALLOWLIST: `send-keys` só é construído se a
 *     sessão-alvo passa em `assertCkptSession` — validado AQUI no momento do
 *     envio, não só na UI. Fora do prefixo → rejeitado e logado via onReject.
 *
 *  2. ESCAPING POR CONSTRUÇÃO (AC5): o texto vai como argumento LITERAL ao
 *     `send-keys -l --` (sem interpretação de key names pelo tmux, sem opção
 *     iniciada por '-'), embrulhado em single-quote POSIX com o único escape
 *     válido ('\'' ). Newlines embutidos são colapsados em espaço — a resposta
 *     termina em EXATAMENTE um Enter, enviado como keystroke separado.
 *
 *  3. GATE DE RISCO: `low` envia direto. `high` (ou
 *     risco desconhecido/decisão fora do snapshot — na dúvida, high) NUNCA
 *     envia no primeiro round-trip: o server devolve um challenge com o
 *     COMANDO EXATO que será executado + um token de uso único vinculado a
 *     (perfil, decisão, sessão, texto). Só a repetição da MESMA resposta com o
 *     token válido envia; o token morre no uso e expira por TTL.
 *
 *  4. HONESTIDADE (AC7): sessão morta/canal indisponível → erro claro, a
 *     decisão PERMANECE na fila, nenhum retry automático (reenviar input a um
 *     terminal é decisão humana).
 *
 * Quem AGE é o app (dono do canal) — o watcher só detecta (F9): o send-keys
 * jamais passa pelo watcher; após o envio, o status vira `answered` via o
 * MESMO patchDecision da 2.6 e a resposta é auditada em `events` do watcher
 * (POST /hook com source 'respond' — via única de escrita já existente).
 */
import { randomUUID } from 'node:crypto';
import { assertCkptSession } from '../tmux/session-name.js';
import type { HostQueryRunner } from './poller.js';
import type { DecisionQueueItem } from '../ws/protocol.js';

/** Superfície do poller que o responder consome (risk lookup + PATCH). */
export interface DecisionSource {
  findDecision(profileId: string, decisionId: number): DecisionQueueItem | undefined;
  patchDecision(
    profileId: string,
    decisionId: number,
    action: 'seen' | 'dismissed' | 'answered',
  ): Promise<boolean>;
}

export interface ResponderOptions {
  queryRunner: HostQueryRunner;
  decisions: DecisionSource;
  /** Porta do watcher NA VPS (auditoria via POST /hook local). Default 4100. */
  watcherPort?: number;
  /** TTL do token de confirmação high (ms). Default 120000 (2min). */
  tokenTtlMs?: number;
  /** Relógio injetável (testes de expiração determinísticos). */
  nowMs?: () => number;
  /** Gerador de token injetável. Default crypto.randomUUID. */
  tokenFactory?: () => string;
  /** Log de tentativas rejeitadas pela allowlist (AC3 — "rejeitada e logada"). */
  onReject?: (info: { profileId: string; sessionName: string; reason: string }) => void;
}

/** Resultado de respond(): ou um challenge (high sem token), ou o desfecho. */
export type RespondOutcome =
  | { kind: 'challenge'; command: string; confirmToken: string }
  | { kind: 'result'; ok: boolean; message?: string };

/** Sentinela de sucesso do send-keys (aparece na saída SÓ se ambos executaram). */
const SENT_MARKER = '__CKPT_SENT_OK__';
const DEFAULT_TOKEN_TTL_MS = 120_000;
const DEFAULT_WATCHER_PORT = 4100;

/**
 * Embrulho single-quote POSIX: o ÚNICO byte especial dentro de '...' é o
 * próprio apóstrofo, escapado como '\''. Nenhuma interpolação de shell é
 * possível por construção (`;`, `$`, backticks, `&` viram texto literal).
 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Normaliza o texto de resposta (AC5): newlines embutidos NÃO viram Enters
 * extras — colapsados em espaço; a resposta termina num único Enter (keystroke
 * separado em buildSendKeysCommand). Controle C0 restante é removido.
 */
export function sanitizeResponseText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
}

/**
 * Constrói o comando EXATO executado na VPS — o mesmo string é exibido no
 * challenge high (AC4: "o comando exato que será injetado").
 * `-l` = literal (sem key names); `--` encerra opções (texto iniciado por '-'
 * é seguro); Enter é um keystroke SEPARADO, único. O marcador só ecoa se os
 * dois send-keys saíram com exit 0 (sessão viva) — é o sinal de sucesso (AC7).
 */
export function buildSendKeysCommand(sessionName: string, text: string): string {
  assertCkptSession(sessionName); // allowlist em command-construction (AC3)
  const target = shellQuote(sessionName);
  const literal = shellQuote(sanitizeResponseText(text));
  return (
    `tmux send-keys -l -t ${target} -- ${literal} && ` +
    `tmux send-keys -t ${target} Enter && echo ${SENT_MARKER}`
  );
}

/** Token pendente de confirmação high — vinculado à resposta INTEIRA. */
interface PendingToken {
  profileId: string;
  decisionId: number;
  sessionName: string;
  text: string;
  expiresAtMs: number;
}

export class DecisionResponder {
  private readonly queryRunner: HostQueryRunner;
  private readonly decisions: DecisionSource;
  private readonly watcherPort: number;
  private readonly tokenTtlMs: number;
  private readonly nowMs: () => number;
  private readonly tokenFactory: () => string;
  private readonly onReject: (info: {
    profileId: string;
    sessionName: string;
    reason: string;
  }) => void;

  /** token → resposta pendente. Uso único: deletado ao validar (AC4). */
  private readonly pendingTokens = new Map<string, PendingToken>();

  constructor(options: ResponderOptions) {
    this.queryRunner = options.queryRunner;
    this.decisions = options.decisions;
    this.watcherPort = options.watcherPort ?? DEFAULT_WATCHER_PORT;
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.tokenFactory = options.tokenFactory ?? (() => randomUUID());
    this.onReject =
      options.onReject ??
      ((info) =>
        console.warn(
          `[respond] REJEITADO (${info.reason}): sessão "${info.sessionName}" perfil ${info.profileId}`,
        ));
  }

  /**
   * Fluxo completo de resposta (AC1–AC7). Nunca lança — todo desfecho é um
   * RespondOutcome que o ws traduz em challenge/result para a UI.
   */
  async respond(input: {
    profileId: string;
    decisionId: number;
    sessionName: string;
    text: string;
    confirmToken?: string;
  }): Promise<RespondOutcome> {
    const { profileId, decisionId, sessionName, confirmToken } = input;
    const text = sanitizeResponseText(input.text);

    // AC3 — allowlist no server, no momento do envio. Rejeição é logada.
    if (!sessionName.startsWith('ckpt-')) {
      this.onReject({ profileId, sessionName, reason: 'fora da allowlist ckpt-' });
      return { kind: 'result', ok: false, message: 'sessão fora da allowlist ckpt-' };
    }
    if (text.length === 0) {
      return { kind: 'result', ok: false, message: 'resposta vazia' };
    }

    // AC4 — risco vem do SNAPSHOT do server (nunca do cliente). Decisão fora
    // do snapshot = risco desconhecido = high (na dúvida, high).
    const decision = this.decisions.findDecision(profileId, decisionId);
    const risk = decision?.risk ?? 'high';

    if (risk === 'high') {
      const valid = confirmToken !== undefined && this.consumeToken(confirmToken, input);
      if (!valid) {
        // Sem token (1º round-trip) OU token inválido/expirado/reusado/para
        // outra resposta: NUNCA envia — devolve o challenge com o comando exato.
        const command = buildSendKeysCommand(sessionName, text);
        const token = this.tokenFactory();
        this.pendingTokens.set(token, {
          profileId,
          decisionId,
          sessionName,
          text,
          expiresAtMs: this.nowMs() + this.tokenTtlMs,
        });
        return { kind: 'challenge', command, confirmToken: token };
      }
    }

    return this.send(profileId, decisionId, sessionName, text, risk);
  }

  /** Valida e CONSOME o token (uso único). true só se casa com a resposta inteira. */
  private consumeToken(
    token: string,
    input: { profileId: string; decisionId: number; sessionName: string; text: string },
  ): boolean {
    const pending = this.pendingTokens.get(token);
    if (!pending) return false;
    this.pendingTokens.delete(token); // uso único: morre AQUI, válido ou não
    if (this.nowMs() > pending.expiresAtMs) return false;
    return (
      pending.profileId === input.profileId &&
      pending.decisionId === input.decisionId &&
      pending.sessionName === input.sessionName &&
      pending.text === sanitizeResponseText(input.text)
    );
  }

  /** Envio efetivo + answered + auditoria. Falha honesta mantém a fila (AC7). */
  private async send(
    profileId: string,
    decisionId: number,
    sessionName: string,
    text: string,
    risk: 'low' | 'high',
  ): Promise<RespondOutcome> {
    let command: string;
    try {
      command = buildSendKeysCommand(sessionName, text);
    } catch (err) {
      this.onReject({ profileId, sessionName, reason: 'assertCkptSession' });
      return {
        kind: 'result',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const output = await this.queryRunner.runHostQuery(profileId, command);
    if (output === null || !output.includes(SENT_MARKER)) {
      // Timeout do canal, perfil desconectado ou sessão morta ("can't find
      // session" no stderr) — erro claro, decisão FICA na fila, sem retry (AC7).
      return {
        kind: 'result',
        ok: false,
        message: `send-keys não confirmado para ${sessionName} (sessão morta ou canal indisponível)`,
      };
    }

    // AC6 — resposta entregue: answered no watcher (sai da fila no próximo
    // sync) + auditoria em events. Falha aqui NÃO desfaz o envio (o texto já
    // chegou ao terminal — o que importa); vira nota no result.
    const patched = await this.decisions.patchDecision(profileId, decisionId, 'answered');
    await this.audit(profileId, { decisionId, sessionName, text, risk, patched });
    return {
      kind: 'result',
      ok: true,
      ...(patched ? {} : { message: 'resposta enviada; PATCH answered falhou (fila atualiza no próximo ciclo)' }),
    };
  }

  /** Auditoria (AC6): registro em `events` do watcher via POST /hook local. */
  private async audit(
    profileId: string,
    payload: {
      decisionId: number;
      sessionName: string;
      text: string;
      risk: string;
      patched: boolean;
    },
  ): Promise<void> {
    const body = JSON.stringify({
      source: 'respond',
      session_name: payload.sessionName,
      decision_id: payload.decisionId,
      response_text: payload.text,
      risk: payload.risk,
      answered_patched: payload.patched,
      via: 'panel',
    });
    try {
      await this.queryRunner.runHostQuery(
        profileId,
        `curl -s --max-time 3 -X POST http://127.0.0.1:${this.watcherPort}/hook ` +
          `-H 'Content-Type: application/json' -d ${shellQuote(body)}`,
      );
    } catch {
      // Auditoria é best-effort: nunca derruba nem desfaz uma resposta entregue.
    }
  }
}
