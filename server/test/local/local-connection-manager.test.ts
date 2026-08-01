import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Profile } from '../../src/db/profiles.js';
import {
  LocalConnectionManager,
  type LocalControlProcess,
  type LocalPty,
} from '../../src/local/local-connection-manager.js';

class FakePty implements LocalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number; signal?: number }) => void;

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListener = listener;
    return { dispose: () => undefined };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => undefined };
  }
  data(value: string): void { this.dataListener?.(value); }
  exit(): void { this.exitListener?.({ exitCode: 0 }); }
}

class FakeControl extends EventEmitter implements LocalControlProcess {
  writes: string[] = [];
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (data: string): boolean => { this.writes.push(data); return true; } };
  kill(): boolean { this.killed = true; return true; }
}

function profile(kind: 'ssh' | 'local'): Profile {
  return {
    id: 1,
    kind,
    name: kind === 'local' ? 'Ryzen' : 'Azure',
    host: kind === 'ssh' ? 'host' : '',
    port: 22,
    user: kind === 'ssh' ? 'ubuntu' : '',
    keyPath: kind === 'ssh' ? '/key' : '',
    createdAt: '',
    updatedAt: '',
  };
}

describe('LocalConnectionManager', () => {
  it('opens an interactive PTY and forwards write, output, resize and close', () => {
    const pty = new FakePty();
    const manager = new LocalConnectionManager({
      profiles: { get: () => profile('local') },
      ptyFactory: () => pty,
      cwd: '/tmp',
      env: { PATH: '/bin' },
    });
    const states: string[] = [];
    const output: string[] = [];
    const closed: string[] = [];
    manager.on('state', ({ state }) => states.push(state));
    manager.on('data', ({ data }) => output.push(data.toString()));
    manager.on('channelClose', ({ channelId }) => closed.push(channelId));

    const channelId = manager.openChannel('1');
    manager.sendData('1', channelId, 'echo oi\n');
    manager.resizeChannel('1', channelId, 120, 40);
    pty.data('oi\r\n');
    manager.closeChannel('1', channelId, 'tile closed');

    expect(states).toEqual(['connected']);
    expect(pty.writes).toEqual(['echo oi\n']);
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(output).toEqual(['oi\r\n']);
    expect(pty.killed).toBe(true);
    expect(closed).toEqual([channelId]);
    expect(manager.channelCount('1')).toBe(0);
  });

  it('uses a non-PTY process for control queries and forwards clean output', () => {
    const control = new FakeControl();
    const ptyFactory = vi.fn(() => new FakePty());
    const manager = new LocalConnectionManager({
      profiles: { get: () => profile('local') },
      ptyFactory,
      controlFactory: () => control,
    });
    const output: string[] = [];
    manager.on('data', ({ data }) => output.push(data.toString()));

    const channelId = manager.openChannel('1', { pty: false });
    manager.sendData('1', channelId, "tmux ls; echo '___CKPT_DONE___'\n");
    control.stdout.emit('data', Buffer.from('ckpt-a: 1 windows\n___CKPT_DONE___\n'));
    manager.closeChannel('1', channelId);

    expect(ptyFactory).not.toHaveBeenCalled();
    expect(control.writes).toEqual(["tmux ls; echo '___CKPT_DONE___'\n"]);
    expect(output).toEqual(['ckpt-a: 1 windows\n___CKPT_DONE___\n']);
    expect(control.killed).toBe(true);
  });

  it('rejects an SSH profile before starting any local process', () => {
    const ptyFactory = vi.fn(() => new FakePty());
    const manager = new LocalConnectionManager({
      profiles: { get: () => profile('ssh') },
      ptyFactory,
    });
    expect(() => manager.openChannel('1')).toThrow('is not local');
    expect(ptyFactory).not.toHaveBeenCalled();
  });

  it('disconnect kills owned processes and reports the local profile closed', () => {
    const first = new FakePty();
    const second = new FakePty();
    const ptys = [first, second];
    const manager = new LocalConnectionManager({
      profiles: { get: () => profile('local') },
      ptyFactory: () => ptys.shift()!,
    });
    const states: string[] = [];
    manager.on('state', ({ state }) => states.push(state));
    manager.openChannel('1');
    manager.openChannel('1');
    manager.disconnect('1');
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
    expect(states).toEqual(['connected', 'closed']);
    expect(manager.stateOf('1')).toBeUndefined();
  });
});
