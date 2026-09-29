import { describe, expect, it } from 'vitest';
import { isDbHostToMainMessage } from '../../db-host-protocol';

describe('isDbHostToMainMessage', () => {
  it.each([
    { kind: 'log', level: 'info', message: 'DB host process started' },
    { id: 'r', kind: 'response', ok: true },
    { kind: 'live-update', liveId: 'live:1', results: { rows: [] } },
  ])('accepts a $kind message', (message) => {
    expect(isDbHostToMainMessage(message)).toBe(true);
  });

  it.each([null, undefined, 'lifecycle', 7, {}, { kind: 3 }])('rejects %j', (value) => {
    expect(isDbHostToMainMessage(value)).toBe(false);
  });

  describe('lifecycle', () => {
    it.each(['closing', 'closed', 'close-failed'] as const)('accepts state %s', (state) => {
      expect(isDbHostToMainMessage({ kind: 'lifecycle', reason: 'SIGINT', state })).toBe(true);
    });

    it.each(['request', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const)('accepts reason %s', (reason) => {
      expect(isDbHostToMainMessage({ kind: 'lifecycle', reason, state: 'closing' })).toBe(true);
    });

    it('accepts a close-failed message that carries its error', () => {
      expect(
        isDbHostToMainMessage({
          error: { message: 'checkpoint failed' },
          kind: 'lifecycle',
          reason: 'SIGTERM',
          state: 'close-failed',
        })
      ).toBe(true);
    });

    it.each([
      ['no state', { kind: 'lifecycle', reason: 'SIGINT' }],
      ['no reason', { kind: 'lifecycle', state: 'closing' }],
      ['an unknown state', { kind: 'lifecycle', reason: 'SIGINT', state: 'opening' }],
      ['an unknown reason', { kind: 'lifecycle', reason: 'SIGUSR1', state: 'closing' }],
      ['a non-string reason', { kind: 'lifecycle', reason: 2, state: 'closing' }],
      ['a non-string state', { kind: 'lifecycle', reason: 'SIGINT', state: ['closing'] }],
    ])('rejects a message with %s', (_name, message) => {
      expect(isDbHostToMainMessage(message)).toBe(false);
    });
  });
});
