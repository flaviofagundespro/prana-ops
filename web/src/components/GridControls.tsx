import type { GridLayout, GridTile } from './TerminalGrid.js';
import type { WatcherSessionStateName } from '../ws-protocol.js';
import type { SessionCoverage } from '../lib/session-coverage.js';

/**
 * Controles do grid no HEADER (feedback do uso diário, 2026-07-15): a barra de
 * layouts 1/2/4/6 e as abas ficavam ACIMA do grid e custavam altura de
 * terminal — subiram para a barra superior, ao lado do logo/badge.
 *
 * Mesmo comportamento de antes: a barra lista TODAS as sessões — a(s)
 * visível(is) em amarelo (você sabe onde está), as ocultas clicáveis para
 * trocar no painel ATIVO; o ✕ fecha a aba sem matar a sessão tmux (o App
 * também fecha o canal). Sempre visível com tiles abertos.
 *
 * MAPA ABA→PAINEL (feedback do uso diário, 2026-07-27): com 2+ painéis, saber
 * que uma aba está "em tela" não bastava — todas ficavam amarelas e o operador
 * não sabia QUAL estava na esquerda e qual na direita. A aba visível agora
 * carrega o NÚMERO do slot que ocupa (1..N em ordem de leitura), o mesmo
 * número exibido no canto do painel — e a aba do painel ATIVO ganha destaque
 * próprio, distinto do "apenas visível". O dado já existia: `visibleIds` é
 * ordenado por slot; o que faltava era não colapsá-lo num Set de booleanos.
 */
export interface GridControlsProps {
  tiles: GridTile[];
  layout: GridLayout;
  /** channelIds visíveis em ordem de slot (do useGridSlots). */
  visibleIds: string[];
  /**
   * Índice (nos visíveis) do painel ativo — a aba correspondente é marcada como
   * ativa, não só "visível". Mesmo valor que o TerminalGrid recebe, para que
   * aba e painel nunca discordem sobre quem está ativo.
   */
  activeIndex: number;
  onLayoutChange: (layout: GridLayout) => void;
  /** Coloca o tile da aba clicada no painel ativo. */
  onPromote: (channelId: string) => void;
  /** Fecha a aba (tile + canal); a sessão tmux segue na VPS. */
  onCloseTile: (tile: GridTile) => void;
  /**
   * Story 2.6 (AC6): estado real do watcher para a sessão da aba, escopado por
   * (profileId, sessionName). undefined = sem sinal → sem indicador (Fase 1
   * exata). `waiting_for_input` é O sinal da epic — o mais chamativo.
   */
  getWatcherState?: (
    profileId: string,
    sessionName: string,
  ) => WatcherSessionStateName | undefined;
  /**
   * Story 2.9 (AC6): cobertura da sessão da aba. Devolve `undefined` quando a
   * derivação não se aplica (prop ausente) — a aba então se comporta como
   * antes da 2.9. A marca de ausência convive com o ponto de estado: uma diz
   * "o que está acontecendo", a outra diz "eu estou mesmo olhando".
   */
  getCoverage?: (profileId: string, sessionName: string) => CoverageBadge | undefined;
}

/** Cobertura já derivada pelo App (a aba não deriva nada por conta própria). */
export interface CoverageBadge {
  coverage: SessionCoverage;
  reason: string | undefined;
}

const LAYOUTS: GridLayout[] = [1, 2, 4, 6];

export function GridControls({
  tiles,
  layout,
  visibleIds,
  activeIndex,
  onLayoutChange,
  onPromote,
  onCloseTile,
  getWatcherState,
  getCoverage,
}: GridControlsProps): JSX.Element {
  // Com um único painel visível a numeração é ruído (só existe o "1") — o
  // número aparece a partir de 2 painéis, mesma regra do destaque de ativo
  // no TerminalGrid.
  const showSlotNumbers = visibleIds.length > 1;
  return (
    <div className="grid-controls">
      <div className="terminal-grid-toolbar" role="toolbar" aria-label="Grid layout">
        {LAYOUTS.map((l) => (
          <button
            key={l}
            type="button"
            className={l === layout ? 'layout-btn layout-btn--active' : 'layout-btn'}
            aria-pressed={l === layout}
            onClick={() => onLayoutChange(l)}
          >
            {l}
          </button>
        ))}
      </div>

      {tiles.length > 0 && (
        <div className="terminal-grid-tabs" role="tablist" aria-label="Terminals">
          {tiles.map((t) => {
            const slotIndex = visibleIds.indexOf(t.channelId);
            const isVisible = slotIndex !== -1;
            const isActivePane = isVisible && showSlotNumbers && slotIndex === activeIndex;
            const label = t.tabLabel ?? t.sessionName;
            const watcherState = getWatcherState?.(t.profileId, t.sessionName);
            const cov = getCoverage?.(t.profileId, t.sessionName);
            const uncovered = cov && cov.coverage !== 'covered' ? cov : undefined;
            const classes = ['grid-tab'];
            if (isVisible) classes.push('grid-tab--current');
            if (isActivePane) classes.push('grid-tab--active-pane');
            // Feedback do uso diário (2026-07-29): a aba visível era mostarda e
            // o ponto de `waiting_for_input` era âmbar — âmbar sobre âmbar, o
            // sinal da epic sumia justamente na aba em que o operador estava.
            //
            // Regra que ficou: a aba VISÍVEL é pintada pelo ESTADO (verde calma
            // / azul thinking); as ocultas seguem cinzas, senão a cor deixaria de
            // responder "onde estou". `waiting_for_input` é a ÚNICA exceção que
            // pinta mesmo oculta — é o único estado que precisa ser visto sem
            // que o operador esteja olhando para ele.
            // `thinking` marca a aba OCULTA também (2026-07-29): a bolinha azul
            // não respondia "posso mandar o próximo comando?" — pequena demais
            // para o operador notar que SUMIU, e é o sumiço que significa
            // "terminou". Visível = preenchimento azul; oculta = moldura azul.
            // O fundo sólido segue exclusivo da visível, então a cor continua
            // dizendo "onde estou" — o que muda é a borda, não o preenchimento.
            // Story 2.18 — `thinking` só pinta quando a cobertura é confiável.
            // Mostrar azul junto de `⃠ no_hooks` era uma contradição e permitia
            // que repaint heurístico parecesse trabalho real. Waiting continua
            // saliente mesmo sem cobertura: na dúvida, não esconder uma dor.
            if (watcherState === 'thinking' && !uncovered) classes.push('grid-tab--thinking');
            if (watcherState === 'waiting_for_input') classes.push('grid-tab--waiting');
            return (
              <span key={t.channelId} className="grid-tab-wrap">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isVisible}
                  className={classes.join(' ')}
                  disabled={isVisible}
                  title={
                    isVisible
                      ? `${label} — painel ${slotIndex + 1}${isActivePane ? ' (ativo)' : ''}`
                      : `${label} — clique para trazer ao painel ${activeIndex + 1}`
                  }
                  onClick={() => onPromote(t.channelId)}
                >
                  {/* Mapa aba→painel: o número do slot que esta aba ocupa, igual
                      ao exibido no canto do painel. Só com 2+ painéis visíveis. */}
                  {isVisible && showSlotNumbers && (
                    <span className="grid-tab-slot" aria-label={`painel ${slotIndex + 1}`}>
                      {slotIndex + 1}
                    </span>
                  )}
                  {/* Story 2.9 (AC6): ausência de sinal na aba. Vem ANTES do
                      ponto de estado porque qualifica o que vem depois — sem
                      cobertura, o estado exibido não é confiável. */}
                  {uncovered && (
                    <span
                      className={`grid-tab-coverage grid-tab-coverage--${uncovered.coverage}`}
                      title={uncovered.reason}
                      aria-label={`sem sinal: ${uncovered.reason ?? uncovered.coverage}`}
                    >
                      ⃠
                    </span>
                  )}
                  {/* Story 2.6 (AC6): indicador do estado real na aba —
                      waiting_for_input é a dor, visualmente o mais saliente. */}
                  {watcherState && (
                    <span
                      className={`grid-tab-state grid-tab-state--${watcherState}`}
                      aria-label={`estado: ${watcherState}`}
                      title={watcherState}
                    >
                      ●
                    </span>
                  )}
                  {label}
                </button>
                <button
                  type="button"
                  className="grid-tab-close"
                  aria-label={`Fechar aba ${label}`}
                  title="Fechar aba (a sessão tmux continua na VPS)"
                  onClick={() => onCloseTile(t)}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
