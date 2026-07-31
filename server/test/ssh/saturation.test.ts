/**
 * Story 2.15 — saturação de canais SSH, sem recurso real.
 *
 * O `MaxSessions` do OpenSSH (default 10) limita canais POR CONEXÃO TCP. Em
 * 2026-07-29 a Azure tinha 10 sessões `ckpt-*`, a host-b menos; as sessões da Azure
 * pararam de abrir e a UI não mostrou NADA — conexão `ESTAB`, `/health` ok,
 * `ssh` manual do terminal funcionando (cada `ssh` é conexão nova, contador
 * próprio). Esse conjunto de fatos levou a duas hipóteses erradas antes da certa.
 *
 * O cliente mock aqui recusa `shell()` a partir do N-ésimo canal — é o servidor
 * saturado, sem servidor nenhum.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ConnectionManager } from '../../src/ssh/connection-manager.js';
import type { ProfileProvider } from '../../src/ssh/connection-manager.js';
import type { Profile } from '../../src/db/profiles.js';

class MockStream extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
  setWindow = vi.fn();
  stderr = new EventEmitter();
}

/**
 * Cliente que aceita `maxSessions` canais e recusa os seguintes com o erro que o
 * `ssh2` entrega quando o sshd responde CHANNEL_OPEN_FAILURE.
 */
class SaturatingClient extends EventEmitter {
  lastConfig: Record<string, unknown> | undefined;
  streams: MockStream[] = [];
  refusals = 0;
  connect = vi.fn((config: Record<string, unknown>) => {
    this.lastConfig = config;
    return this;
  });
  end = vi.fn();

  constructor(private readonly maxSessions: number) {
    super();
  }

  shell = vi.fn((_window: unknown, cb: (err: Error | undefined, stream?: MockStream) => void) => {
    if (this.streams.length >= this.maxSessions) {
      this.refusals += 1;
      const err = new Error('(SSH) Channel open failure: open failed') as Error & { reason: string };
      err.reason = 'ADMINISTRATIVELY_PROHIBITED';
      cb(err, undefined);
      return this;
    }
    const stream = new MockStream();
    this.streams.push(stream);
    cb(undefined, stream);
    return this;
  });

  becomeReady(): void {
    this.emit('ready');
  }
}

const PROFILE: Profile = {
  id: 1,
  name: 'azure',
  host: '10.0.0.1',
  port: 22,
  user: 'ubuntu',
  keyPath: '/home/op/.ssh/id_ed25519',
  createdAt: '2026-07-29',
  updatedAt: '2026-07-29',
};

const profileProvider: ProfileProvider = {
  get: (id) => (id === PROFILE.id ? PROFILE : null),
};

/** Cada conexão nova do pool ganha um cliente com o MESMO teto (é o mesmo sshd). */
function makeSaturatingFactory(maxSessions: number): {
  factory: () => SaturatingClient;
  clients: SaturatingClient[];
} {
  const clients: SaturatingClient[] = [];
  return {
    factory: () => {
      const client = new SaturatingClient(maxSessions);
      clients.push(client);
      return client;
    },
    clients,
  };
}

let manager: ConnectionManager;
let clients: SaturatingClient[];
let errors: { channelId?: string; message: string }[];
/**
 * `ready` é idempotente para o manager (ele reabre os canais registrados), então
 * reemitir num cliente JÁ pronto duplicaria streams e falsearia o teto. Cada
 * cliente é acordado uma única vez.
 */
let readied: WeakSet<object>;

function readyNewClients(): void {
  for (const client of clients) {
    if (readied.has(client)) continue;
    readied.add(client);
    client.becomeReady();
  }
}

/** Sobe o manager com teto `ceiling` e conecta a primeira conexão. */
function boot(ceiling: number): void {
  const { factory, clients: list } = makeSaturatingFactory(ceiling);
  clients = list;
  errors = [];
  readied = new WeakSet();
  manager = new ConnectionManager({
    profiles: profileProvider,
    clientFactory: factory as unknown as () => never,
    readPrivateKey: () => Buffer.from('chave-falsa'),
    scheduler: () => undefined, // sem timers de reconexão nestes testes
  });
  manager.on('channelError', (payload) => errors.push(payload));
}

/** Abre `n` terminais (pty) e deixa cada conexão nova pronta assim que nasce. */
function openTerminals(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(manager.openChannel('1', { pty: true }));
    readyNewClients();
  }
  return ids;
}

describe('Story 2.15 — saturação de canais SSH', () => {
  beforeEach(() => {
    errors = [];
  });

  it('AC7 (zero regressão): abaixo do teto, o profile usa UMA conexão', () => {
    boot(10);
    openTerminals(6);

    expect(manager.connectionCount()).toBe(1);
    expect(manager.channelCount('1')).toBe(6);
    // Nada foi aprendido porque nada saturou — e nada foi reclamado na tela.
    expect(manager.observedChannelCeiling('1')).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it('AC1+AC3: ao bater o teto, nasce UMA conexão adicional e o canal vai para ela', () => {
    boot(3);
    openTerminals(3);
    expect(manager.connectionCount()).toBe(1);

    // O 4º canal é recusado pelo sshd.
    const quarto = manager.openChannel('1', { pty: true });
    readyNewClients();

    expect(clients[0]?.refusals).toBe(1);
    expect(manager.connectionCount()).toBe(2);
    // O canal existe e está VIVO — na segunda conexão.
    expect(manager.channelCount('1')).toBe(4);
    expect(clients[1]?.streams).toHaveLength(1);
    // E o id é o mesmo que o chamador recebeu: quem roteia dados não vê a mudança.
    expect(quarto).toBe('1:4');
  });

  it('AC5: o teto é APRENDIDO da recusa — não é 10 nem 60 hardcoded', () => {
    boot(4);
    openTerminals(4);
    manager.openChannel('1', { pty: true });
    readyNewClients();

    // Quatro canais coexistiam quando a recusa chegou.
    expect(manager.observedChannelCeiling('1')).toBe(4);

    // Um servidor com outro teto aprende outro número — nada no código fixa isso.
    boot(7);
    openTerminals(7);
    manager.openChannel('1', { pty: true });
    readyNewClients();
    expect(manager.observedChannelCeiling('1')).toBe(7);
  });

  it('AC2: o operador é avisado em TEXTO acionável, uma vez por descoberta', () => {
    boot(3);
    openTerminals(3);
    manager.openChannel('1', { pty: true });
    readyNewClients();

    expect(errors).toHaveLength(1);
    const [aviso] = errors;
    // Diz o que aconteceu...
    expect(aviso?.message).toMatch(/recusou um canal/i);
    // ...com o número que ele pode conferir na VPS...
    expect(aviso?.message).toContain('MaxSessions');
    expect(aviso?.message).toMatch(/~3 canais/);
    // ...e o que o cockpit está fazendo a respeito.
    expect(aviso?.message).toMatch(/conexão adicional/i);
    // Atribuído ao canal, para o tile do operador poder mostrar.
    expect(aviso?.channelId).toBe('1:4');
  });

  it('AC2: a descoberta não vira ruído — saturar de novo não repete o aviso', () => {
    boot(2);
    openTerminals(2);
    manager.openChannel('1', { pty: true });
    readyNewClients();
    expect(errors).toHaveLength(1);

    // Continua abrindo até saturar a segunda conexão também.
    openTerminals(4);
    expect(errors).toHaveLength(1);
    expect(manager.connectionCount()).toBeGreaterThan(2);
  });

  it('AC6(d): as sessões já abertas não caem durante o processo', () => {
    boot(3);
    const abertos = openTerminals(3);
    const streamsAntes = clients[0]?.streams.length;

    manager.openChannel('1', { pty: true });
    readyNewClients();

    // Nenhum stream da primeira conexão foi encerrado...
    expect(clients[0]?.streams).toHaveLength(streamsAntes ?? 0);
    for (const stream of clients[0]?.streams ?? []) {
      expect(stream.end).not.toHaveBeenCalled();
    }
    // ...e os canais antigos continuam roteáveis (escrita chega no stream).
    manager.sendData('1', abertos[0] as string, 'ls\n');
    expect(clients[0]?.streams[0]?.write).toHaveBeenCalledWith('ls\n');
  });

  it('AC4: canais de controle não consomem a cota das janelas', () => {
    boot(6);
    // Satura para o teto ser aprendido (6).
    openTerminals(6);
    manager.openChannel('1', { pty: true });
    readyNewClients();
    expect(manager.observedChannelCeiling('1')).toBe(6);

    // Com teto 6 e reserva de 2, sessões cabem até 4 por conexão. A segunda
    // conexão já tem 1 (o canal remanejado); a próxima sessão ainda cabe nela.
    const antes = manager.connectionCount();
    manager.openChannel('1', { pty: true });
    readyNewClients();
    expect(manager.connectionCount()).toBe(antes);

    // Já um canal de CONTROLE pode usar o teto cheio — inclusive a reserva.
    const controle = manager.openChannel('1', { pty: false });
    readyNewClients();
    expect(manager.channelCount('1')).toBeGreaterThan(0);
    expect(controle).toMatch(/^1:/);
  });

  it('AC1: erro de canal que NÃO é limite não abre conexão nenhuma', () => {
    const clientList: MockClientOther[] = [];
    errors = [];
    manager = new ConnectionManager({
      profiles: profileProvider,
      clientFactory: (() => {
        const c = new MockClientOther();
        clientList.push(c);
        return c;
      }) as unknown as () => never,
      readPrivateKey: () => Buffer.from('chave-falsa'),
      scheduler: () => undefined,
    });
    manager.on('channelError', (payload) => errors.push(payload));

    manager.openChannel('1', { pty: true });
    clientList[0]?.becomeReady();
    manager.openChannel('1', { pty: true });
    clientList[0]?.becomeReady();

    // Uma conexão só: a causa não é teto, e abrir outra seria insistir contra um
    // servidor que está recusando por outro motivo.
    expect(manager.connectionCount()).toBe(1);
    expect(manager.observedChannelCeiling('1')).toBeUndefined();
    expect(errors.some((e) => /failed to open channel/.test(e.message))).toBe(true);
  });

  it('recusa sem NENHUM canal vivo não é tratada como teto', () => {
    // Teto 0: a primeira tentativa já é recusada. Aprender "teto = 0" travaria o
    // profile para sempre — nenhum canal jamais caberia.
    boot(0);
    manager.openChannel('1', { pty: true });
    readyNewClients();

    expect(manager.observedChannelCeiling('1')).toBeUndefined();
    expect(manager.connectionCount()).toBe(1);
  });
});

/** Cliente cujo `shell()` falha por motivo que NÃO é limite de sessões. */
class MockClientOther extends EventEmitter {
  streams: MockStream[] = [];
  connect = vi.fn(() => this);
  end = vi.fn();
  shell = vi.fn((_window: unknown, cb: (err: Error | undefined, stream?: MockStream) => void) => {
    if (this.streams.length >= 1) {
      cb(new Error('unknown channel type'), undefined);
      return this;
    }
    const stream = new MockStream();
    this.streams.push(stream);
    cb(undefined, stream);
    return this;
  });
  becomeReady(): void {
    this.emit('ready');
  }
}
