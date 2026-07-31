/**
 * DecisionsPanel tests (Story 2.6, AC5/AC7): render da lista (perfil, sessão,
 * summary, risco high destacado, timestamp "atualizado há X"), ações
 * vista/descartada disparando onAction com (profileId, decisionId, action),
 * estado vazio e fechamento. Relógio injetado — nenhum timer real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { DecisionsPanel } from './DecisionsPanel.js';
import type { AggregatedDecision, RespondChallenge } from '../hooks/useWatcher.js';

afterEach(cleanup);

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

const decisions: AggregatedDecision[] = [
  {
    id: 3,
    profileId: '1',
    sessionName: 'ckpt-prana-claude-1',
    summary: 'Aprovar deploy em produção?',
    risk: 'high',
    status: 'pending',
    updatedAt: '2026-07-16 11:55:00.000',
  },
  {
    id: 9,
    profileId: '2',
    sessionName: 'ckpt-site-codex-1',
    summary: 'Rodar lint?',
    risk: 'low',
    status: 'seen',
    updatedAt: '2026-07-16 11:59:28.000',
  },
];

const profileLabel = (id: string): string => (id === '1' ? 'azure' : 'host-b');

describe('DecisionsPanel (AC5/AC7)', () => {
  it('lista sessão, summary, perfil (multi-VPS) e risco com high destacado', () => {
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        nowMs={NOW}
      />,
    );

    expect(screen.getByText('ckpt-prana-claude-1')).toBeInTheDocument();
    expect(screen.getByText('Aprovar deploy em produção?')).toBeInTheDocument();
    // AC7: decisões de perfis DIFERENTES no mesmo painel, identificadas.
    expect(screen.getByText('azure')).toBeInTheDocument();
    expect(screen.getByText('host-b')).toBeInTheDocument();
    // Risco high com classe visual distinta (AC5).
    expect(screen.getByLabelText('risco: high').className).toContain(
      'decisions-panel__risk--high',
    );
  });

  it('rotula o timestamp como "atualizado há X" — nunca "criado" (DOC-002)', () => {
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText('atualizado há 5min')).toBeInTheDocument();
    expect(screen.getByText('atualizado há 32s')).toBeInTheDocument();
    expect(screen.queryByText(/criad/)).not.toBeInTheDocument();
  });

  it('vista/descartar disparam onAction com (profileId, decisionId, action)', () => {
    const onAction = vi.fn();
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={onAction}
        onClose={() => {}}
        nowMs={NOW}
      />,
    );

    fireEvent.click(screen.getByLabelText('Marcar decisão 3 como vista'));
    expect(onAction).toHaveBeenCalledWith('1', 3, 'seen');

    fireEvent.click(screen.getByLabelText('Descartar decisão 9'));
    expect(onAction).toHaveBeenCalledWith('2', 9, 'dismissed');
  });

  it('decisão já vista não oferece "vista" de novo (só descartar)', () => {
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByLabelText('Marcar decisão 9 como vista')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Descartar decisão 9')).toBeInTheDocument();
  });

  it('y/n e texto livre disparam onRespond SEM confirmToken (1º round-trip) (Story 2.7, AC1)', () => {
    const onRespond = vi.fn();
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        onRespond={onRespond}
        nowMs={NOW}
      />,
    );

    fireEvent.click(screen.getByLabelText('Responder sim à decisão 3'));
    expect(onRespond).toHaveBeenCalledWith('1', 3, 'ckpt-prana-claude-1', 'y');

    const input = screen.getByLabelText('Resposta livre para a decisão 9');
    fireEvent.change(input, { target: { value: 'usa a abordagem 2' } });
    fireEvent.click(screen.getByLabelText('Enviar resposta livre à decisão 9'));
    expect(onRespond).toHaveBeenLastCalledWith('2', 9, 'ckpt-site-codex-1', 'usa a abordagem 2');
  });

  it('gate high: exibe o comando exato e só envia com o token ao confirmar (Story 2.7, AC4)', () => {
    const onRespond = vi.fn();
    const challenge: RespondChallenge = {
      profileId: '1',
      decisionId: 3,
      sessionName: 'ckpt-prana-claude-1',
      command: `tmux send-keys -l -t 'ckpt-prana-claude-1' -- 'rm -rf ./build' && tmux send-keys -t 'ckpt-prana-claude-1' Enter`,
      confirmToken: 'tok-42',
      text: 'rm -rf ./build',
    };
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        onRespond={onRespond}
        challengeFor={(p, id) => (p === '1' && id === 3 ? challenge : undefined)}
        nowMs={NOW}
      />,
    );

    // O comando EXATO está visível ANTES de qualquer confirmação.
    expect(screen.getByText(challenge.command)).toBeInTheDocument();

    // Confirmar reenvia o MESMO texto COM o token de uso único.
    fireEvent.click(screen.getByLabelText('Confirmar e enviar resposta à decisão 3'));
    expect(onRespond).toHaveBeenCalledWith('1', 3, 'ckpt-prana-claude-1', 'rm -rf ./build', 'tok-42');
  });

  it('cancelar o desafio high chama onCancelChallenge, sem enviar (Story 2.7, AC4)', () => {
    const onRespond = vi.fn();
    const onCancelChallenge = vi.fn();
    const challenge: RespondChallenge = {
      profileId: '1', decisionId: 3, sessionName: 'ckpt-prana-claude-1',
      command: 'tmux send-keys ...', confirmToken: 'tok-42', text: 'y',
    };
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        onRespond={onRespond}
        challengeFor={() => challenge}
        onCancelChallenge={onCancelChallenge}
        nowMs={NOW}
      />,
    );
    // Só a decisão 3 tem challenge (o mock devolve para todas — usa a 3).
    fireEvent.click(screen.getAllByLabelText('Cancelar resposta à decisão 3')[0]);
    expect(onCancelChallenge).toHaveBeenCalledWith('1', 3);
  });

  it('falha honesta: mensagem de erro exibida sem sumir da fila (Story 2.7, AC7)', () => {
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        onRespond={vi.fn()}
        resultFor={(p, id) =>
          p === '1' && id === 3 ? { ok: false, message: 'sessão morta ou canal indisponível' } : undefined
        }
        nowMs={NOW}
      />,
    );
    expect(screen.getByText('sessão morta ou canal indisponível')).toBeInTheDocument();
    // A decisão continua listada.
    expect(screen.getByText('ckpt-prana-claude-1')).toBeInTheDocument();
  });

  it('sem onRespond o painel fica só com vista/descartar (2.6 — retrocompatível)', () => {
    render(
      <DecisionsPanel
        decisions={decisions}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={() => {}}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByLabelText('Responder sim à decisão 3')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Descartar decisão 3')).toBeInTheDocument();
  });

  it('fila vazia mostra estado vazio; ✕ fecha o painel', () => {
    const onClose = vi.fn();
    render(
      <DecisionsPanel
        decisions={[]}
        profileLabel={profileLabel}
        onAction={() => {}}
        onClose={onClose}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText('Nenhuma decisão na fila.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Fechar fila de decisões'));
    expect(onClose).toHaveBeenCalled();
  });
});
