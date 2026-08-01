/** Routes the existing channel contract by profile kind (Story 2.19). */
import { EventEmitter } from 'node:events';
import type { ConnectionState } from '../ws/protocol.js';
import {
  ConnectionManager,
  type ConnectionManagerEvents,
  type ConnectionManagerOptions,
  type ProfileProvider,
} from '../ssh/connection-manager.js';
import {
  LocalConnectionManager,
  type LocalConnectionManagerOptions,
} from '../local/local-connection-manager.js';

export interface ProfileConnectionManagerOptions {
  profiles: ProfileProvider;
  sshManager?: ConnectionManager;
  localManager?: LocalConnectionManager;
  sshOptions?: Omit<ConnectionManagerOptions, 'profiles'>;
  localOptions?: Omit<LocalConnectionManagerOptions, 'profiles'>;
}

export interface ProfileChannelTransport {
  openChannel(profileId: string, opts?: { pty?: boolean; initCommand?: string }): string;
  sendData(profileId: string, channelId: string, data: string): void;
  resizeChannel(profileId: string, channelId: string, cols: number, rows: number): void;
  closeChannel(profileId: string, channelId: string, reason?: string): void;
  disconnect(profileId: string): void;
  disconnectAll(): void;
  stateOf(profileId: string): ConnectionState | undefined;
  on<E extends keyof ConnectionManagerEvents>(event: E, listener: ConnectionManagerEvents[E]): unknown;
  off(event: keyof ConnectionManagerEvents, listener: (...args: unknown[]) => void): unknown;
}

export class ProfileConnectionManager extends EventEmitter implements ProfileChannelTransport {
  readonly ssh: ConnectionManager;
  readonly local: LocalConnectionManager;
  private readonly channelRoutes = new Map<string, ConnectionManager | LocalConnectionManager>();

  constructor(private readonly options: ProfileConnectionManagerOptions) {
    super();
    this.ssh = options.sshManager ?? new ConnectionManager({ profiles: options.profiles, ...options.sshOptions });
    this.local =
      options.localManager ??
      new LocalConnectionManager({ profiles: options.profiles, ...options.localOptions });
    this.forward(this.ssh);
    this.forward(this.local);
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
    const manager = this.managerFor(profileId);
    const channelId = manager.openChannel(profileId, opts);
    this.channelRoutes.set(channelId, manager);
    return channelId;
  }

  sendData(profileId: string, channelId: string, data: string): void {
    (this.channelRoutes.get(channelId) ?? this.managerFor(profileId)).sendData(
      profileId,
      channelId,
      data,
    );
  }

  resizeChannel(profileId: string, channelId: string, cols: number, rows: number): void {
    (this.channelRoutes.get(channelId) ?? this.managerFor(profileId)).resizeChannel(
      profileId,
      channelId,
      cols,
      rows,
    );
  }

  closeChannel(profileId: string, channelId: string, reason?: string): void {
    const manager = this.channelRoutes.get(channelId);
    if (manager) {
      manager.closeChannel(profileId, channelId, reason);
      return;
    }
    // Unknown/stale channel: both implementations are idempotent. This path is
    // safe even after the profile row was deleted.
    this.ssh.closeChannel(profileId, channelId, reason);
    this.local.closeChannel(profileId, channelId, reason);
  }

  disconnect(profileId: string): void {
    // Deletion removes the row before invoking its lifecycle callback, so route
    // cleanup to both managers instead of consulting a profile that no longer exists.
    this.ssh.disconnect(profileId);
    this.local.disconnect(profileId);
  }

  disconnectAll(): void {
    this.ssh.disconnectAll();
    this.local.disconnectAll();
  }

  stateOf(profileId: string): ConnectionState | undefined {
    return this.managerFor(profileId).stateOf(profileId);
  }

  private managerFor(profileId: string): ConnectionManager | LocalConnectionManager {
    const profile = this.options.profiles.get(Number(profileId));
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    return profile.kind === 'local' ? this.local : this.ssh;
  }

  private forward(manager: ConnectionManager | LocalConnectionManager): void {
    manager.on('state', (payload) => this.emit('state', payload));
    manager.on('data', (payload) => this.emit('data', payload));
    manager.on('channelClose', (payload) => {
      this.channelRoutes.delete(payload.channelId);
      this.emit('channelClose', payload);
    });
    manager.on('channelError', (payload) => this.emit('channelError', payload));
  }
}
