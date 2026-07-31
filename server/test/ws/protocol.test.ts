/**
 * ws protocol parser tests (AC9): the typed envelope is parsed and validated
 * from untrusted client input without throwing, and the ratified shapes hold
 * (client channel:open carries profileId ONLY; channel:close accepts optional
 * code/reason).
 */
import { describe, it, expect } from 'vitest';
import { parseClientMessage } from '../../src/ws/protocol.js';

describe('parseClientMessage', () => {
  it('parses channel:open with profileId only (server mints channelId)', () => {
    expect(parseClientMessage({ type: 'channel:open', profileId: '1' })).toEqual({
      type: 'channel:open',
      profileId: '1',
    });
  });

  it('parses channel:data', () => {
    expect(
      parseClientMessage({ type: 'channel:data', channelId: '1:1', data: 'ls\n' }),
    ).toEqual({ type: 'channel:data', channelId: '1:1', data: 'ls\n' });
  });

  it('parses channel:resize with numeric cols/rows', () => {
    expect(
      parseClientMessage({ type: 'channel:resize', channelId: '1:1', cols: 120, rows: 40 }),
    ).toEqual({ type: 'channel:resize', channelId: '1:1', cols: 120, rows: 40 });
  });

  it('parses channel:close with and without optional code/reason', () => {
    expect(parseClientMessage({ type: 'channel:close', channelId: '1:1' })).toEqual({
      type: 'channel:close',
      channelId: '1:1',
    });
    expect(
      parseClientMessage({ type: 'channel:close', channelId: '1:1', code: 0, reason: 'user' }),
    ).toEqual({ type: 'channel:close', channelId: '1:1', code: 0, reason: 'user' });
  });

  it('rejects malformed / unknown messages by returning null (never throws)', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('nope')).toBeNull();
    expect(parseClientMessage({ type: 'ping' })).toBeNull();
    expect(parseClientMessage({ type: 'channel:open' })).toBeNull(); // missing profileId
    expect(parseClientMessage({ type: 'channel:data', channelId: '1' })).toBeNull(); // missing data
    expect(
      parseClientMessage({ type: 'channel:resize', channelId: '1', cols: 'x', rows: 40 }),
    ).toBeNull();
    expect(
      parseClientMessage({ type: 'channel:resize', channelId: '1', cols: Infinity, rows: 40 }),
    ).toBeNull();
  });
});
