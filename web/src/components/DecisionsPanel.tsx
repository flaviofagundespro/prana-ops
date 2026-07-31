import { useState } from 'react';
import type {
  AggregatedDecision,
  RespondChallenge,
  RespondResult,
} from '../hooks/useWatcher.js';
import { relativeTime } from '../lib/relative-time.js';

/**
 * Painel da fila de decisões (Story 2.6, AC5/AC7) — abre pelo badge. Escopo
 * visual DELIBERADAMENTE mínimo (guarda-corpo ⚖️ da análise da live): lista +
 * duas ações. Sem filtros, buscas, sons ou animações.
 *
 * Cada item: perfil (multi-VPS, AC7), sessão, summary, risco (`high` com
 * destaque visual) e timestamp relativo rotulado "atualizado há X" — NUNCA
 * "criado há X": o instante vem do `created_at` do watcher, que é
 * semanticamente "última atualização" (DOC-002 do gate 2.5).
 *
 * Ações (AC5): "vista" (pending → seen, permanece marcada) e "descartar"
 * (sai da fila). Ambas viram `decisions:action` no ws — o item some/atualiza
 * quando o `decisions:update` do re-poll chega (fonte de verdade é o watcher;
 * nenhum estado otimista local para ficar mentindo em caso de falha).
 *
 * RESPONDER a decisão é Story 2.7 — nenhum send-keys aqui.
 */
export interface DecisionsPanelProps {
  decisions: AggregatedDecision[];
  /** Rótulo do perfil de origem (multi-VPS, AC7); id cru se desconhecido. */
  profileLabel: (profileId: string) => string;
  onAction: (profileId: string, decisionId: number, action: 'seen' | 'dismissed') => void;
  onClose: () => void;
  /** Test seam: relógio injetável para timestamps relativos determinísticos. */
  nowMs?: number;
  /**
   * Story 2.7 (AC1/AC4): responde uma decisão (y/n ou texto). `low` envia
   * direto; `high` volta como challenge — a confirmação reenvia o mesmo texto
   * com o token. Opcional: sem ele, o painel fica só com vista/descartar (2.6).
   */
  onRespond?: (
    profileId: string,
    decisionId: number,
    sessionName: string,
    text: string,
    confirmToken?: string,
  ) => void;
  /** Desafio high pendente da decisão (comando exato + token) — AC4. */
  challengeFor?: (profileId: string, decisionId: number) => RespondChallenge | undefined;
  /** Cancela o desafio pendente. */
  onCancelChallenge?: (profileId: string, decisionId: number) => void;
  /** Desfecho da última resposta (falha honesta exibida sem sair da fila) — AC7. */
  resultFor?: (profileId: string, decisionId: number) => RespondResult | undefined;
}

export function DecisionsPanel({
  decisions,
  profileLabel,
  onAction,
  onClose,
  nowMs,
  onRespond,
  challengeFor,
  onCancelChallenge,
  resultFor,
}: DecisionsPanelProps): JSX.Element {
  return (
    <aside className="decisions-panel" role="dialog" aria-label="Fila de decisões">
      <header className="decisions-panel__header">
        <h2 className="decisions-panel__title">Decisões</h2>
        <button
          type="button"
          className="decisions-panel__close"
          aria-label="Fechar fila de decisões"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      {decisions.length === 0 ? (
        <p className="decisions-panel__empty">Nenhuma decisão na fila.</p>
      ) : (
        <ul className="decisions-panel__list">
          {decisions.map((d) => (
            <DecisionItem
              key={`${d.profileId}:${d.id}`}
              decision={d}
              profileLabel={profileLabel}
              onAction={onAction}
              nowMs={nowMs}
              {...(onRespond ? { onRespond } : {})}
              {...(challengeFor ? { challenge: challengeFor(d.profileId, d.id) } : {})}
              {...(onCancelChallenge ? { onCancelChallenge } : {})}
              {...(resultFor ? { result: resultFor(d.profileId, d.id) } : {})}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

interface DecisionItemProps {
  decision: AggregatedDecision;
  profileLabel: (profileId: string) => string;
  onAction: (profileId: string, decisionId: number, action: 'seen' | 'dismissed') => void;
  nowMs?: number;
  onRespond?: (
    profileId: string,
    decisionId: number,
    sessionName: string,
    text: string,
    confirmToken?: string,
  ) => void;
  challenge?: RespondChallenge;
  onCancelChallenge?: (profileId: string, decisionId: number) => void;
  result?: RespondResult;
}

/**
 * Um item da fila com a ação RESPONDER (Story 2.7). O campo de texto tem estado
 * local (por isso é componente próprio). y/n são atalhos que respondem na hora;
 * "responder" envia o texto livre. Quando o server devolve um challenge (high),
 * o item mostra o COMANDO EXATO e só então habilita "Confirmar e enviar" — o
 * envio real reenvia o mesmo texto com o token de uso único (AC4). O gate NÃO é
 * decidido aqui: a UI SEMPRE manda a resposta; é o server que responde direto
 * (low) ou devolve o challenge (high) — a UI nunca decide sozinha que algo é
 * seguro.
 */
function DecisionItem({
  decision: d,
  profileLabel,
  onAction,
  nowMs,
  onRespond,
  challenge,
  onCancelChallenge,
  result,
}: DecisionItemProps): JSX.Element {
  const [text, setText] = useState('');

  const send = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || !onRespond) return;
    onRespond(d.profileId, d.id, d.sessionName, trimmed);
  };

  return (
    <li
      className={
        d.status === 'seen'
          ? 'decisions-panel__item decisions-panel__item--seen'
          : 'decisions-panel__item'
      }
    >
      <div className="decisions-panel__meta">
        <span className="decisions-panel__profile">{profileLabel(d.profileId)}</span>
        <span className="decisions-panel__session">{d.sessionName}</span>
        <span
          className={`decisions-panel__risk decisions-panel__risk--${d.risk}`}
          aria-label={`risco: ${d.risk}`}
        >
          {d.risk}
        </span>
      </div>
      <p className="decisions-panel__summary">{d.summary}</p>

      {onRespond && (
        <div className="decisions-panel__respond">
          <div className="decisions-panel__yn">
            <button
              type="button"
              className="decisions-panel__action"
              aria-label={`Responder sim à decisão ${d.id}`}
              onClick={() => send('y')}
            >
              y
            </button>
            <button
              type="button"
              className="decisions-panel__action"
              aria-label={`Responder não à decisão ${d.id}`}
              onClick={() => send('n')}
            >
              n
            </button>
            <input
              type="text"
              className="decisions-panel__respond-input"
              aria-label={`Resposta livre para a decisão ${d.id}`}
              placeholder="resposta livre…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  send(text);
                  setText('');
                }
              }}
            />
            <button
              type="button"
              className="decisions-panel__action"
              aria-label={`Enviar resposta livre à decisão ${d.id}`}
              disabled={text.trim().length === 0}
              onClick={() => {
                send(text);
                setText('');
              }}
            >
              responder
            </button>
          </div>

          {/* AC4 — gate high: comando exato + confirmação explícita. */}
          {challenge && (
            <div className="decisions-panel__challenge" role="alert">
              <p className="decisions-panel__challenge-warn">
                Risco {d.risk} — confirme o comando exato que será injetado:
              </p>
              <code className="decisions-panel__challenge-cmd">{challenge.command}</code>
              <div className="decisions-panel__challenge-actions">
                <button
                  type="button"
                  className="decisions-panel__action decisions-panel__action--confirm"
                  aria-label={`Confirmar e enviar resposta à decisão ${d.id}`}
                  onClick={() =>
                    onRespond(
                      challenge.profileId,
                      challenge.decisionId,
                      challenge.sessionName,
                      challenge.text,
                      challenge.confirmToken,
                    )
                  }
                >
                  Confirmar e enviar
                </button>
                <button
                  type="button"
                  className="decisions-panel__action"
                  aria-label={`Cancelar resposta à decisão ${d.id}`}
                  onClick={() => onCancelChallenge?.(d.profileId, d.id)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* AC7 — falha honesta: exibida sem tirar a decisão da fila. */}
          {result && !result.ok && (
            <p className="decisions-panel__respond-error" role="alert">
              {result.message ?? 'falha ao responder — a decisão continua na fila'}
            </p>
          )}
        </div>
      )}

      <div className="decisions-panel__footer">
        <span className="decisions-panel__time">
          atualizado há {relativeTime(d.updatedAt, nowMs)}
        </span>
        {d.status === 'pending' && (
          <button
            type="button"
            className="decisions-panel__action"
            aria-label={`Marcar decisão ${d.id} como vista`}
            onClick={() => onAction(d.profileId, d.id, 'seen')}
          >
            vista
          </button>
        )}
        <button
          type="button"
          className="decisions-panel__action decisions-panel__action--dismiss"
          aria-label={`Descartar decisão ${d.id}`}
          onClick={() => onAction(d.profileId, d.id, 'dismissed')}
        >
          descartar
        </button>
      </div>
    </li>
  );
}
