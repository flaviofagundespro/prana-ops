/**
 * Local transport for Story 2.19.
 *
 * Interactive channels use a real pseudoterminal so tmux, Claude and Codex see
 * a TTY and receive resize events. Control channels deliberately use ordinary
 * child-process pipes: tmux/curl queries do not need a TTY and their output must
 * not echo the command back into the query parser.
 */
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import type { Profile } from '../db/profiles.js';
import type {
  ConnectionManagerEvents,
  ProfileProvider,
} from '../ssh/connection-manager.js';
import type { ConnectionState } from '../ws/protocol.js';

const esmRequire = createRequire(import.meta.url);

export interface LocalPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface LocalControlProcess {
  stdin: { write(data: string): boolean };
  stdout: { on(event: 'data', listener: (data: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (data: Buffer) => void): unknown };
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type LocalPtyFactory = (options: {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}) => LocalPty;

export type LocalControlFactory = (options: {
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => LocalControlProcess;

export interface LocalConnectionManagerOptions {
  profiles: ProfileProvider;
  ptyFactory?: LocalPtyFactory;
  controlFactory?: LocalControlFactory;
  shell?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface LocalChannel {
  channelId: string;
  pty: boolean;
  cols: number;
  rows: number;
  terminal?: LocalPty;
  control?: LocalControlProcess;
}

interface LocalProfile {
  channels: Map<string, LocalChannel>;
  sequence: number;
  state: ConnectionState;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function cleanEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function defaultPtyFactory(options: Parameters<LocalPtyFactory>[0]): IPty {
  // node-pty is a native addon and is not thread-safe. Load it only when a real
  // local terminal is requested; unit tests inject a factory and never touch
  // the addon from Vitest workers.
  const { spawn } = esmRequire('node-pty') as typeof import('node-pty');
  // Interactive shell keeps the operator's normal rc/aliases. The cockpit does
  // not copy or rewrite them; it merely launches the same shell under a PTY.
  return spawn(options.shell, [], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });
}

function defaultControlFactory(
  options: Parameters<LocalControlFactory>[0],
): ChildProcessWithoutNullStreams {
  return spawnProcess(options.shell, ['--noprofile', '--norc'], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
  });
}

export class LocalConnectionManager extends EventEmitter {
  private readonly profiles: ProfileProvider;
  private readonly ptyFactory: LocalPtyFactory;
  private readonly controlFactory: LocalControlFactory;
  private readonly shell: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly localProfiles = new Map<string, LocalProfile>();

  constructor(options: LocalConnectionManagerOptions) {
    super();
    this.profiles = options.profiles;
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory;
    this.controlFactory = options.controlFactory ?? defaultControlFactory;
    this.shell = options.shell ?? process.env.SHELL ?? '/bin/bash';
    this.cwd = options.cwd ?? process.env.HOME ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  override on<E extends keyof ConnectionManagerEvents>(
    event: E,
    listener: ConnectionManagerEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof ConnectionManagerEvents>(
    event: E,
    ...args: Parameters<ConnectionManagerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  openChannel(profileId: string, opts?: { pty?: boolean; initCommand?: string }): string {
    const profile = this.localProfile(profileId);
    const runtime = this.ensureProfile(profileId);
    runtime.sequence += 1;
    const channelId = `${profileId}:local:${runtime.sequence}`;
    const channel: LocalChannel = {
      channelId,
      pty: opts?.pty !== false,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    runtime.channels.set(channelId, channel);

    try {
      if (channel.pty) this.openTerminal(profileId, runtime, channel);
      else this.openControl(profileId, runtime, channel);
    } catch (error) {
      runtime.channels.delete(channelId);
      this.emit('channelError', {
        profileId,
        channelId,
        message: `failed to open local channel: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }

    // Keep the lookup above intentional: it validates that the profile still
    // exists and is local before a process is started.
    void profile;
    return channelId;
  }

  private openTerminal(profileId: string, runtime: LocalProfile, channel: LocalChannel): void {
    const terminal = this.ptyFactory({
      shell: this.shell,
      cwd: this.cwd,
      env: cleanEnvironment(this.env),
      cols: channel.cols,
      rows: channel.rows,
    });
    channel.terminal = terminal;
    terminal.onData((data) => {
      if (runtime.channels.get(channel.channelId) !== channel) return;
      this.emit('data', { profileId, channelId: channel.channelId, data: Buffer.from(data) });
    });
    terminal.onExit(() => this.handleNaturalClose(profileId, runtime, channel));
  }

  private openControl(profileId: string, runtime: LocalProfile, channel: LocalChannel): void {
    const control = this.controlFactory({ shell: this.shell, cwd: this.cwd, env: this.env });
    channel.control = control;
    const forward = (data: Buffer): void => {
      if (runtime.channels.get(channel.channelId) !== channel) return;
      this.emit('data', { profileId, channelId: channel.channelId, data });
    };
    control.stdout.on('data', forward);
    control.stderr.on('data', forward);
    control.on('error', (error) => {
      if (runtime.channels.get(channel.channelId) !== channel) return;
      this.emit('channelError', {
        profileId,
        channelId: channel.channelId,
        message: `local channel error: ${error.message}`,
      });
    });
    control.on('close', () => this.handleNaturalClose(profileId, runtime, channel));
  }

  sendData(profileId: string, channelId: string, data: string): void {
    const channel = this.localProfiles.get(profileId)?.channels.get(channelId);
    if (!channel) return;
    if (channel.terminal) channel.terminal.write(data);
    else channel.control?.stdin.write(data);
  }

  resizeChannel(profileId: string, channelId: string, cols: number, rows: number): void {
    const channel = this.localProfiles.get(profileId)?.channels.get(channelId);
    if (!channel || !channel.terminal) return;
    channel.cols = cols;
    channel.rows = rows;
    channel.terminal.resize(cols, rows);
  }

  closeChannel(profileId: string, channelId: string, reason?: string): void {
    const runtime = this.localProfiles.get(profileId);
    const channel = runtime?.channels.get(channelId);
    if (!runtime || !channel) return;
    runtime.channels.delete(channelId);
    try {
      if (channel.terminal) channel.terminal.kill();
      else channel.control?.kill('SIGTERM');
    } catch (error) {
      this.emit('channelError', {
        profileId,
        channelId,
        message: `error closing local channel: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.emit('channelClose', { profileId, channelId, reason });
  }

  disconnect(profileId: string): void {
    const runtime = this.localProfiles.get(profileId);
    if (!runtime) return;
    for (const channelId of [...runtime.channels.keys()]) {
      this.closeChannel(profileId, channelId, 'disconnect');
    }
    runtime.state = 'closed';
    this.emit('state', { profileId, state: 'closed' });
    this.localProfiles.delete(profileId);
  }

  disconnectAll(): void {
    for (const profileId of [...this.localProfiles.keys()]) this.disconnect(profileId);
  }

  stateOf(profileId: string): ConnectionState | undefined {
    return this.localProfiles.get(profileId)?.state;
  }

  channelCount(profileId: string): number {
    return this.localProfiles.get(profileId)?.channels.size ?? 0;
  }

  private localProfile(profileId: string): Profile {
    const profile = this.profiles.get(Number(profileId));
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    if (profile.kind !== 'local') throw new Error(`Profile ${profileId} is not local`);
    return profile;
  }

  private ensureProfile(profileId: string): LocalProfile {
    const existing = this.localProfiles.get(profileId);
    if (existing) return existing;
    const runtime: LocalProfile = { channels: new Map(), sequence: 0, state: 'connected' };
    this.localProfiles.set(profileId, runtime);
    this.emit('state', { profileId, state: 'connected' });
    return runtime;
  }

  private handleNaturalClose(
    profileId: string,
    runtime: LocalProfile,
    channel: LocalChannel,
  ): void {
    if (runtime.channels.get(channel.channelId) !== channel) return;
    runtime.channels.delete(channel.channelId);
    this.emit('channelClose', { profileId, channelId: channel.channelId, reason: 'process exited' });
  }
}
