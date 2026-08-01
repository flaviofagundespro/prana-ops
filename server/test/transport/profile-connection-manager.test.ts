import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import type { Profile } from '../../src/db/profiles.js';
import { ConnectionManager } from '../../src/ssh/connection-manager.js';
import { LocalConnectionManager, type LocalPty } from '../../src/local/local-connection-manager.js';
import { ProfileConnectionManager } from '../../src/transport/profile-connection-manager.js';

class FakePty implements LocalPty {
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(): { dispose(): void } { return { dispose: () => undefined }; }
}

class FakeSshManager extends EventEmitter {
  openChannel = vi.fn((profileId: string) => `${profileId}:ssh:1`);
  sendData = vi.fn();
  resizeChannel = vi.fn();
  closeChannel = vi.fn();
  disconnect = vi.fn();
  disconnectAll = vi.fn();
  stateOf = vi.fn(() => 'connected' as const);
}

const profiles = new Map<number, Profile>([
  [1, { id: 1, kind: 'local', name: 'Ryzen', host: '', port: 22, user: '', keyPath: '', createdAt: '', updatedAt: '' }],
  [2, { id: 2, kind: 'ssh', name: 'Azure', host: 'azure', port: 22, user: 'ubuntu', keyPath: '/key', createdAt: '', updatedAt: '' }],
]);

describe('ProfileConnectionManager', () => {
  it('routes local profiles without constructing an SSH client', () => {
    const provider = { get: (id: number) => profiles.get(id) ?? null };
    const sshFactory = vi.fn(() => ({} as Client));
    const ptyFactory = vi.fn(() => new FakePty());
    const ssh = new ConnectionManager({ profiles: provider, clientFactory: sshFactory });
    const local = new LocalConnectionManager({ profiles: provider, ptyFactory });
    const manager = new ProfileConnectionManager({ profiles: provider, sshManager: ssh, localManager: local });

    const states: string[] = [];
    manager.on('state', ({ profileId, state }) => states.push(`${profileId}:${state}`));
    const channelId = manager.openChannel('1');

    expect(channelId).toMatch(/^1:local:/);
    expect(ptyFactory).toHaveBeenCalledOnce();
    expect(sshFactory).not.toHaveBeenCalled();
    expect(states).toEqual(['1:connected']);
  });

  it('preserves the SSH route for legacy profiles', () => {
    const provider = { get: (id: number) => profiles.get(id) ?? null };
    const ssh = new FakeSshManager();
    const ptyFactory = vi.fn(() => new FakePty());
    const local = new LocalConnectionManager({ profiles: provider, ptyFactory });
    const manager = new ProfileConnectionManager({
      profiles: provider,
      sshManager: ssh as unknown as ConnectionManager,
      localManager: local,
    });

    const channelId = manager.openChannel('2');
    manager.sendData('2', channelId, 'pwd\n');

    expect(channelId).toBe('2:ssh:1');
    expect(ssh.openChannel).toHaveBeenCalledWith('2', undefined);
    expect(ssh.sendData).toHaveBeenCalledWith('2', channelId, 'pwd\n');
    expect(ptyFactory).not.toHaveBeenCalled();
  });
});
