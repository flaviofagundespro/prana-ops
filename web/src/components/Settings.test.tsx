/**
 * Settings tests (Story 1.6, Task 4, AC2/AC4/AC5).
 *
 * CRUD against a mocked `fetch` prop (GET/POST/PUT/DELETE): list, create, edit,
 * delete, and server-error surfacing. Plus negative assertions: no password field
 * anywhere in the DOM (AC4), no Telegram/watcher reference (AC5).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { Settings, type Profile } from './Settings.js';
import type { WsClient, WsMessageListener } from '../lib/ws-client.js';
import type { ClientToServerMessage, ServerToClientMessage } from '../ws-protocol.js';

afterEach(cleanup);

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const seed: Profile[] = [
  { id: 1, name: 'azure', host: '10.0.0.1', port: 22, user: 'deploy', keyPath: '/k/a' },
];

describe('Settings (AC2/AC4/AC5)', () => {
  it('lists existing profiles from GET /api/profiles', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — deploy@10\.0\.0\.1:22/)).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith('/api/profiles');
  });

  it('creates a new profile (POST) and reloads the list', async () => {
    const created: Profile = { id: 2, name: 'host-b', host: 'h2', port: 22, user: 'u', keyPath: '/k/z' };
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(created, true, 201);
      // First GET returns seed; later GET returns seed + created.
      return jsonResponse(fetchFn.mock.calls.filter((c) => c[0] === '/api/profiles').length > 1 ? [...seed, created] : seed);
    });
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'host-b' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'h2' } });
    fireEvent.change(screen.getByLabelText('Usuário'), { target: { value: 'u' } });
    fireEvent.change(screen.getByLabelText('Path da chave'), { target: { value: '/k/z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar perfil' }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/profiles',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/host-b — /)).toBeInTheDocument());
  });

  it('edits a profile (PUT) with the correct id', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return jsonResponse({ ...seed[0], host: 'new-host' });
      return jsonResponse(seed);
    });
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Editar azure' }));
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'new-host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/profiles/1', expect.objectContaining({ method: 'PUT' })),
    );
  });

  it('deletes a profile (DELETE) with the correct id', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return jsonResponse(undefined, true, 204);
      return jsonResponse(seed);
    });
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Excluir azure' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/profiles/1', expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('surfaces a server 400 inline without breaking the screen', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ error: 'name, host, user and keyPath are required' }, false, 400);
      return jsonResponse(seed);
    });
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    // Fill all required fields client-side so the request actually reaches the server.
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('Usuário'), { target: { value: 'u' } });
    fireEvent.change(screen.getByLabelText('Path da chave'), { target: { value: '/k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar perfil' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/required/));
    // Screen still functional: the list is still shown.
    expect(screen.getByText(/azure — /)).toBeInTheDocument();
  });

  it('blocks submit client-side when required fields are missing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Criar perfil' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/obrigatórios/);
    // No POST was issued.
    expect(fetchFn).not.toHaveBeenCalledWith('/api/profiles', expect.objectContaining({ method: 'POST' }));
  });

  it('has NO password field anywhere (AC4)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    const { container } = render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/senha/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('has NO Telegram/watcher references (AC5)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    const { container } = render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    expect(within(container).queryByText(/telegram/i)).not.toBeInTheDocument();
    expect(within(container).queryByText(/watcher/i)).not.toBeInTheDocument();
  });

  it('connection test: loading → ok (AC3)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    const ws = makeFakeWs();
    render(<Settings fetchFn={fetchFn} ws={ws} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão azure' }));
    // Sends the ws request and shows the loading state.
    expect(ws.sent).toContainEqual({ type: 'profile:test-connection', profileId: '1' });
    expect(screen.getByRole('status')).toHaveTextContent('testando');

    // Server replies ok → OK state.
    act(() => {
      ws.push({ type: 'profile:test-connection:result', profileId: '1', ok: true });
    });
    expect(screen.getByRole('status')).toHaveTextContent('conexão OK');
  });

  it('connection test: loading → error with the server message (AC3)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    const ws = makeFakeWs();
    render(<Settings fetchFn={fetchFn} ws={ws} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão azure' }));
    act(() => {
      ws.push({ type: 'profile:test-connection:result', profileId: '1', ok: false, message: 'connection error' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('erro: connection error');
  });

  it('disables the test button when no ws is provided', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(seed));
    render(<Settings fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText(/azure — /)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Testar conexão azure' })).toBeDisabled();
  });
});
