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

    const command = createEmbeddingHostCommand(
      'reset',
      'embedding-host:runtime-1',
      'embedding-host:runtime-2'
    );

    expect(command).toEqual({
      channel: 'control',
      payload: { action: 'reset', nextRuntimeId: 'embedding-host:runtime-2' },
      requestId: 'embedding-host-command:1234-5678-9012',
      runtimeId: 'embedding-host:runtime-1',
      type: 'request',
    });
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on malformed embedding host commands', () => {
    expect(() =>
      assertEmbeddingHostCommand({
        channel: 'control',
        payload: { action: 'pause' },
        requestId: 'request-1',
        runtimeId: 'embedding-host:runtime-1',
        type: 'request',
      })
    ).toThrow('Embedding host command payload.action must be "reset" or "stop".');
  });

  it('fails fast when reset commands omit nextRuntimeId', () => {
    expect(() =>
      assertEmbeddingHostCommand({
        channel: 'control',
        payload: { action: 'reset' },
        requestId: 'request-1',
        runtimeId: 'embedding-host:runtime-1',
        type: 'request',
      })
    ).toThrow('Embedding host reset commands require a non-empty payload.nextRuntimeId.');
  });

  it('fails fast when command creation receives a blank runtime id', () => {
    expect(() => createEmbeddingHostCommand('stop', '   ')).toThrow(
      'Embedding host command runtimeId must be a non-empty string.'
    );
  });

  it('fails fast when reset command creation receives a blank next runtime id', () => {
    expect(() => createEmbeddingHostCommand('reset', 'embedding-host:runtime-1', '   ')).toThrow(
      'Embedding host reset commands require a non-empty nextRuntimeId.'
    );
  });
});
