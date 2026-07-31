/**
 * SessionForm tests (AC6, AC10): submitting sends session:create with the form
 * fields; session:created bubbles up (App spawns the tile); session:error renders
 * inline without breaking the form; session:list populates the reopen list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { SessionForm } from './SessionForm.js';
import type { WsClient, WsMessageListener } from '../lib/ws-client.js';
import type { ClientToServerMessage, ServerToClientMessage } from '../ws-protocol.js';

function makeFakeWs(): WsClient & {
  sent: ClientToServerMessage[];
  push: (m: ServerToClientMessage) => void;
} {
  const sent: ClientToServerMessage[] = [];
  const listeners = new Set<WsMessageListener>();
  return {
    sent,
    push: (m) => listeners.forEach((l) => l(m)),
    send: (m) => sent.push(m),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

afterEach(cleanup);

describe('SessionForm (AC6)', () => {
  it('sends session:list on mount for the default profile', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);
    expect(ws.sent).toContainEqual({ type: 'session:list', profileId: '1' });
  });

  it('sends session:create with the entered fields on submit', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);

    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'cockpit' } });
    fireEvent.change(screen.getByLabelText('Pauta'), { target: { value: 'grid de terminais' } });
    fireEvent.change(screen.getByLabelText('Agente'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));

    expect(ws.sent).toContainEqual({
      type: 'session:create',
      profileId: '1',
      projeto: 'cockpit',
      pauta: 'grid de terminais',
      agente: 'codex',
    });
  });

  it('bubbles session:created up via onSessionCreated', () => {
    const ws = makeFakeWs();
    const onSessionCreated = vi.fn();
    render(<SessionForm ws={ws} onSessionCreated={onSessionCreated} />);

    act(() => {
      ws.push({ type: 'session:created', profileId: '1', sessionName: 'ckpt-cockpit-claude-1', channelId: 'p1:9', project: '', label: '' });
    });

    expect(onSessionCreated).toHaveBeenCalledWith({
      type: 'session:created',
      profileId: '1',
      sessionName: 'ckpt-cockpit-claude-1',
      channelId: 'p1:9',
      project: '',
      label: '',
    });
  });

  it('renders session:error inline without breaking the form', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);

    act(() => {
      ws.push({ type: 'session:error', profileId: '1', message: 'tmux manager unavailable' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('tmux manager unavailable');
    // Form still functional: can still submit afterwards.
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'session:create', projeto: 'x' }));
  });

  it('populates the reopen list from session:list', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);

    act(() => {
      ws.push({ type: 'session:list', profileId: '1', sessions: ['ckpt-a-claude-1', 'ckpt-b-codex-1'] });
    });

    const list = screen.getByLabelText('Sessões existentes');
    expect(list).toHaveTextContent('Reabrir ckpt-a-claude-1');
    expect(list).toHaveTextContent('Reabrir ckpt-b-codex-1');
  });

  it('UX-001: Reabrir derives projeto/assunto/n from the clicked name, NOT the form fields', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);

    // Form filled with DIFFERENT values than the session to reopen.
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'cockpit' } });
    fireEvent.change(screen.getByLabelText('Pauta'), { target: { value: 'alguma pauta' } });
    fireEvent.change(screen.getByLabelText('Agente'), { target: { value: 'claude' } });

    act(() => {
      ws.push({ type: 'session:list', profileId: '1', sessions: ['ckpt-outroprojeto-codex-2'] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir ckpt-outroprojeto-codex-2' }));

    // The reopen must target the EXACT named session. Story 2.12: quem
    // reconstrói o nome no server é `pauta` (o ASSUNTO extraído do nome), então
    // ela vem do nome clicado — não do campo do formulário. O `agente` deixou
    // de participar do nome e segue o valor corrente do form (é só rótulo).
    expect(ws.sent).toContainEqual({
      type: 'session:create',
      profileId: '1',
      projeto: 'outroprojeto',
      pauta: 'codex',
      agente: 'claude',
      n: 2,
    });
  });

  it('UX-001: a non-canonical session name falls back to the form values without throwing', () => {
    const ws = makeFakeWs();
    render(<SessionForm ws={ws} onSessionCreated={() => {}} />);

    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'cockpit' } });
    fireEvent.change(screen.getByLabelText('Agente'), { target: { value: 'claude' } });

    act(() => {
      ws.push({ type: 'session:list', profileId: '1', sessions: ['legacy-session-name'] });
    });
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Reabrir legacy-session-name' })),
    ).not.toThrow();

    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'session:create', projeto: 'cockpit', agente: 'claude' }),
    );
  });

  it('uses injected profiles when provided (real profiles from App — AC6)', () => {
    const ws = makeFakeWs();
    render(
      <SessionForm
        ws={ws}
        onSessionCreated={() => {}}
        profiles={[{ id: '7', label: 'azure (10.0.0.1)' }]}
      />,
    );
    // session:list on mount uses the injected profile id, not the mock's '1'.
    expect(ws.sent).toContainEqual({ type: 'session:list', profileId: '7' });
    expect(screen.getByText('azure (10.0.0.1)')).toBeInTheDocument();
  });
});
