import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertEmbeddingHostCommand, createEmbeddingHostCommand } from '../embedding-host-shared';

describe('embedding host shared command helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a strict embedding host command envelope', () => {
    const randomUUIDMock = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('1234-5678-9012');

    const command = createEmbeddingHostCommand('reset', 'embedding-host:runtime-1');

    expect(command).toEqual({
      type: 'request',
      channel: 'control',
      requestId: 'embedding-host-command:1234-5678-9012',
      runtimeId: 'embedding-host:runtime-1',
      payload: { action: 'reset' },
    });
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on malformed embedding host commands', () => {
    expect(() =>
      assertEmbeddingHostCommand({
        type: 'request',
        channel: 'control',
        requestId: 'request-1',
        runtimeId: 'embedding-host:runtime-1',
        payload: { action: 'pause' },
      })
    ).toThrow('Embedding host command payload.action must be "reset" or "stop".');
  });
});
