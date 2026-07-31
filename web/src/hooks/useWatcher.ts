import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DecisionQueueItem,
  SessionStateItem,
  WatcherSessionStateName,
} from '../ws-protocol.js';
import type { WsClient } from '../lib/ws-client.js';

/** Story 2.7 — desafio de confirmação pendente para uma resposta `high`. */
export interface RespondChallenge {
  profileId: string;
  decisionId: number;
  sessionName: string;
  /** Comando EXATO que será executado na VPS (exibido no gate). */
  command: string;
  confirmToken: string;
  /** Texto que o operador digitou — reenviado com o token na confirmação. */
  text: string;
}

/** Story 2.7 — desfecho da última resposta de uma decisão (para feedback na UI). */
export interface RespondResult {
  ok: boolean;
  message?: string;
}

/**
 * Estado do watcher no app (Story 2.6, AC4/AC5/AC6/AC7): assina
 * `decisions:update` / `sessions:state` no ws compartilhado e mantém fila +
 * estados POR PERFIL — a identidade é (profileId, sessionName), lição da
 * Fase 1 (o MESMO nome de sessão pode existir em duas VPS ao mesmo tempo).
 *
 * F9 por construção: nada aqui infere estado — só armazena o que o watcher
 * já decidiu e o server transportou. Perfil sem watcher fica com
 * `available=false` e mapas vazios: a UI degrada para a Fase 1 (AC3).
 */

/** Decisão da fila agregada, anotada com o perfil de origem (AC7). */
export type AggregatedDecision = DecisionQueueItem & { profileId: string };

export interface WatcherSync {
  /** Contagem de decisões `pending` de TODOS os perfis (badge, AC4). */
  pendingCount: number;
  /** Fila agregada multi-VPS, na ordem de chegada por perfil (painel, AC5/AC7). */
  decisions: AggregatedDecision[];
  /** false = watcher indisponível no perfil (AC3); undefined = nunca reportado. */
  watcherAvailable: (profileId: string) => boolean | undefined;
  /** Estado real da sessão segundo o watcher; undefined = sem sinal (AC6). */
  stateOf: (profileId: string, sessionName: string) => WatcherSessionStateName | undefined;
  /**
   * Story 2.9/AC3 — o item completo do watcher para a sessão (inclui
   * `stateSince`), insumo da derivação de cobertura. undefined = o watcher não
   * conhece esta sessão.
   */
  stateItemOf: (profileId: string, sessionName: string) => SessionStateItem | undefined;
  /** Story 2.10/AC5 — re-arme do pipe esgotado para esta sessão. */
  pipeUnrecoverable: (profileId: string, sessionName: string) => boolean;
  /** Story 2.11/AC3 — agente iniciado antes dos hooks (informativo). */
  agentWithoutHooks: (profileId: string, sessionName: string) => boolean;
  /** Story 2.12 — o agente em uso não lê os hooks (reciclar não resolve). */
  hooksUnsupported: (profileId: string, sessionName: string) => boolean;
  /** Dispara vista/descartada (AC5) — o resultado volta como decisions:update. */
  applyAction: (profileId: string, decisionId: number, action: 'seen' | 'dismissed') => void;
  /**
   * Story 2.7 (AC1/AC4): responde uma decisão (y/n ou texto). `low` envia
   * direto; `high` volta como challenge (ver `challengeFor`) — a confirmação
   * reenvia o MESMO texto com o token. `confirmToken` é omitido no 1º envio.
   */
  respond: (
    profileId: string,
    decisionId: number,
    sessionName: string,
    text: string,
    confirmToken?: string,
  ) => void;
  /** Desafio de confirmação high pendente para a decisão, se houver (AC4). */
  challengeFor: (profileId: string, decisionId: number) => RespondChallenge | undefined;
  /** Descarta o desafio pendente (operador cancelou a confirmação). */
  clearChallenge: (profileId: string, decisionId: number) => void;
  /** Último resultado de resposta da decisão (feedback de falha honesta, AC7). */
  resultFor: (profileId: string, decisionId: number) => RespondResult | undefined;
  /**
   * "A IA respondeu e você ainda não olhou" (2026-07-29).
   *
   * NÃO é um estado do watcher — é estado da ATENÇÃO do operador, e por isso
   * vive só no cliente. O watcher sabe que o agente parou de escrever; ele não
   * sabe (nem pode saber) se o operador leu. Derivar isso do watcher faria a
   * marca ficar PREGADA na aba para sempre, virando um segundo `idle` — que é
   * exatamente o ruído que o modelo precisa evitar.
   *
   * Nasce na transição `thinking → idle` e morre em {@link markSeen}.
   */
  hasResponded: (profileId: string, sessionName: string) => boolean;
  /**
   * Consome a marca acima. Chamado quando a sessão está num painel visível —
   * "trazer a aba ao painel" é o ato que conta como ter visto (definido pelo
   * operador em 2026-07-29). Idempotente: sem marca, não re-renderiza.
   */
  markSeen: (profileId: string, sessionName: string) => void;
}

/** Chave estável por decisão multi-VPS: (profileId, decisionId). */
function decisionKey(profileId: string, decisionId: number): string {
  return `${profileId}:${decisionId}`;
}

export function useWatcher(ws: WsClient): WatcherSync {
  const [decisionsByProfile, setDecisionsByProfile] = useState<
    Record<string, DecisionQueueItem[]>
  >({});
  const [availableByProfile, setAvailableByProfile] = useState<Record<string, boolean>>({});
  // Story 2.10/AC5 — sessões com re-arme de pipe esgotado, por perfil.
  const [deadPipesByProfile, setDeadPipesByProfile] = useState<Record<string, Set<string>>>({});
  // Story 2.11/AC3 — sessões cujo agente roda sem hooks, por perfil.
  const [noHooksByProfile, setNoHooksByProfile] = useState<Record<string, Set<string>>>({});
  // Story 2.12 — sessões cujo agente não lê esses hooks (reciclar não resolve).
  const [unsupportedByProfile, setUnsupportedByProfile] = useState<Record<string, Set<string>>>({});
  // Story 2.9/AC3: guarda o ITEM inteiro, não só o nome do estado. O
  // `stateSince` é o que permite perguntar "há quanto tempo está assim" — sem
  // ele a cobertura não é derivável, e antes desta story ele era descartado
  // aqui mesmo, na entrada do hook.
  const [statesByProfile, setStatesByProfile] = useState<
    Record<string, Record<string, SessionStateItem>>
  >({});
  // Story 2.7 — desafios high pendentes e últimos resultados, por decisão.
  const [challenges, setChallenges] = useState<Record<string, RespondChallenge>>({});
  const [results, setResults] = useState<Record<string, RespondResult>>({});
  // Texto do último send por decisão — o challenge do server não reecoa o
  // texto (segurança: menos superfície), então a UI o preserva para reenviar
  // com o token. Ref (não state): lido dentro do handler do ws sem re-render.
  const pendingText = useRef(new Map<string, string>()).current;
  // "Respondeu e você não viu", por perfil. Ver `hasResponded` na interface.
  const [respondedByProfile, setRespondedByProfile] = useState<Record<string, Set<string>>>({});
  // Último estado conhecido por sessão — a marca nasce da TRANSIÇÃO, não do
  // estado corrente (`idle` sozinho não distingue "terminou agora" de "nunca
  // começou"). Ref, não state: é insumo de comparação, não deve re-renderizar.
  const lastStates = useRef<Record<string, Record<string, WatcherSessionStateName>>>({}).current;

  useEffect(() => {
    return ws.subscribe((message) => {
      if (message.type === 'decisions:update') {
        setAvailableByProfile((prev) => ({
          ...prev,
          [message.profileId]: message.watcherAvailable,
        }));
        setDecisionsByProfile((prev) => ({ ...prev, [message.profileId]: message.decisions }));
      } else if (message.type === 'sessions:state') {
        setDeadPipesByProfile((prev) => ({
          ...prev,
          [message.profileId]: new Set(message.unrecoverablePipes ?? []),
        }));
        setNoHooksByProfile((prev) => ({
          ...prev,
          [message.profileId]: new Set(message.sessionsWithoutHooks ?? []),
        }));
        setUnsupportedByProfile((prev) => ({
          ...prev,
          [message.profileId]: new Set(message.sessionsHooksUnsupported ?? []),
        }));
        // Transição `thinking → idle` = "a IA acabou de responder". Comparada
        // ANTES de atualizar o snapshot, senão o anterior já teria sido perdido.
        const seenBefore = lastStates[message.profileId] ?? {};
        const justResponded = message.states
          .filter((s) => seenBefore[s.sessionName] === 'thinking' && s.state === 'idle')
          .map((s) => s.sessionName);
        lastStates[message.profileId] = Object.fromEntries(
          message.states.map((s) => [s.sessionName, s.state]),
        );
        if (justResponded.length > 0) {
          setRespondedByProfile((prev) => {
            const next = new Set(prev[message.profileId] ?? []);
            for (const name of justResponded) next.add(name);
            return { ...prev, [message.profileId]: next };
          });
        }
        setStatesByProfile((prev) => ({
          ...prev,
          [message.profileId]: Object.fromEntries(
            message.states.map((s) => [s.sessionName, s]),
          ),
        }));
      } else if (message.type === 'decisions:respond:challenge') {
        // Guarda o desafio; o texto original vem do send que o originou (via
        // pendingText abaixo) — o challenge do server não reecoa o texto.
        const key = decisionKey(message.profileId, message.decisionId);
        setChallenges((prev) => ({
          ...prev,
          [key]: {
            profileId: message.profileId,
            decisionId: message.decisionId,
            sessionName: message.sessionName,
            command: message.command,
            confirmToken: message.confirmToken,
            text: pendingText.get(key) ?? '',
          },
        }));
      } else if (message.type === 'decisions:respond:result') {
        const key = decisionKey(message.profileId, message.decisionId);
        setResults((prev) => ({
          ...prev,
          [key]: { ok: message.ok, ...(message.message ? { message: message.message } : {}) },
        }));
        // Sucesso ou falha: o desafio pendente deixou de ser relevante.
        setChallenges((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    });
  }, [ws]);

  const decisions = useMemo<AggregatedDecision[]>(
    () =>
      Object.entries(decisionsByProfile).flatMap(([profileId, list]) =>
        list.map((d) => ({ ...d, profileId })),
      ),
    [decisionsByProfile],
  );

  const pendingCount = useMemo(
    () => decisions.filter((d) => d.status === 'pending').length,
    [decisions],
  );

  const watcherAvailable = useCallback(
    (profileId: string): boolean | undefined => availableByProfile[profileId],
    [availableByProfile],
  );

  const stateOf = useCallback(
    (profileId: string, sessionName: string): WatcherSessionStateName | undefined =>
      statesByProfile[profileId]?.[sessionName]?.state,
    [statesByProfile],
  );

  /**
   * Story 2.10/AC5 — o cockpit tentou re-armar o pipe desta sessão e desistiu.
   * `false` enquanto ele ainda está curando (o que leva ~10s) — a UI só acusa
   * cano morto depois que a cura falhou.
   */
  const pipeUnrecoverable = useCallback(
    (profileId: string, sessionName: string): boolean =>
      deadPipesByProfile[profileId]?.has(sessionName) ?? false,
    [deadPipesByProfile],
  );

  /**
   * Story 2.11/AC3 — o agente desta sessão iniciou antes dos hooks. Informa;
   * a cura (reiniciar o agente) é decisão do operador, não da UI.
   */
  const agentWithoutHooks = useCallback(
    (profileId: string, sessionName: string): boolean =>
      noHooksByProfile[profileId]?.has(sessionName) ?? false,
    [noHooksByProfile],
  );

  /** Story 2.12 — o agente desta sessão não lê os hooks do Claude Code. */
  const hooksUnsupported = useCallback(
    (profileId: string, sessionName: string): boolean =>
      unsupportedByProfile[profileId]?.has(sessionName) ?? false,
    [unsupportedByProfile],
  );

  /** Story 2.9/AC3 — item completo (com `stateSince`) para derivar cobertura. */
  const stateItemOf = useCallback(
    (profileId: string, sessionName: string): SessionStateItem | undefined =>
      statesByProfile[profileId]?.[sessionName],
    [statesByProfile],
  );

  const applyAction = useCallback(
    (profileId: string, decisionId: number, action: 'seen' | 'dismissed'): void => {
      ws.send({ type: 'decisions:action', profileId, decisionId, action });
    },
    [ws],
  );

  const respond = useCallback(
    (
      profileId: string,
      decisionId: number,
      sessionName: string,
      text: string,
      confirmToken?: string,
    ): void => {
      const key = decisionKey(profileId, decisionId);
      pendingText.set(key, text);
      // Novo envio limpa o resultado anterior (não confundir feedback velho).
      setResults((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      ws.send({
        type: 'decisions:respond',
        profileId,
        decisionId,
        sessionName,
        text,
        ...(confirmToken ? { confirmToken } : {}),
      });
    },
    [ws, pendingText],
  );

  const challengeFor = useCallback(
    (profileId: string, decisionId: number): RespondChallenge | undefined =>
      challenges[decisionKey(profileId, decisionId)],
    [challenges],
  );

  const clearChallenge = useCallback(
    (profileId: string, decisionId: number): void => {
      const key = decisionKey(profileId, decisionId);
      setChallenges((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const hasResponded = useCallback(
    (profileId: string, sessionName: string): boolean =>
      respondedByProfile[profileId]?.has(sessionName) ?? false,
    [respondedByProfile],
  );

  const markSeen = useCallback((profileId: string, sessionName: string): void => {
    setRespondedByProfile((prev) => {
      // Sem marca → devolve o MESMO objeto. Importante: o App chama isto num
      // efeito disparado pela própria mudança de estado; sem esta saída o par
      // efeito↔estado não convergiria.
      if (!prev[profileId]?.has(sessionName)) return prev;
      const next = new Set(prev[profileId]);
      next.delete(sessionName);
      return { ...prev, [profileId]: next };
    });
  }, []);

  const resultFor = useCallback(
    (profileId: string, decisionId: number): RespondResult | undefined =>
      results[decisionKey(profileId, decisionId)],
    [results],
  );

  return {
    pendingCount,
    decisions,
    watcherAvailable,
    stateOf,
    stateItemOf,
    pipeUnrecoverable,
    agentWithoutHooks,
    hooksUnsupported,
    applyAction,
    respond,
    challengeFor,
    clearChallenge,
    resultFor,
    hasResponded,
    markSeen,
  };
}
