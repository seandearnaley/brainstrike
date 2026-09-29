import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingHostCommand,
  assertEmbeddingHostStatus,
  createEmbeddingHostCommand,
} from '../embedding-host-shared';

describe('embedding host shared command helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves exact control acknowledgement identity and rejects malformed identities', () => {
    const status = {
      active: false,
      lastError: null,
      runtimeId: 'runtime',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    };
    expect(assertEmbeddingHostStatus({ ...status, commandId: 'stop-request' })).toMatchObject({
      commandId: 'stop-request',
    });
    for (const commandId of ['', ' ', 1, null]) {
      expect(() => assertEmbeddingHostStatus({ ...status, commandId })).toThrow(
        'non-empty commandId'
      );
    }
  });

  it('creates a strict embedding host command envelope', () => {
    const randomUUIDMock = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('1234-5678-9012' as unknown as ReturnType<Crypto['randomUUID']>);

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

  it('validates embedding telemetry crossing the host status boundary', () => {
    expect(
      assertEmbeddingHostStatus({
        active: false,
        embeddingRuntime: {
          actualWorkerMetadata: null,
          backendMismatch: false,
          selectedDevicePreference: 'webgpu',
          telemetry: {
            batchTransfer: { batchCount: 1, lastBytes: 12, peakBytes: 12, totalBytes: 12 },
            cache: {
              entries: [],
              estimatedGpuBytes: 0,
              estimatedHeapBytes: 0,
              memoryEstimateUnavailableCount: 0,
              residentCount: 0,
            },
            health: { failureCount: 0, lastFailure: null },
            lastUpdatedAt: 1000,
            peakVectorsInFlight: 1,
          },
        },
        lastError: null,
        runtimeId: 'embedding-host:runtime-1',
        runtimeKind: 'embedding-host',
        state: 'running',
      }).embeddingRuntime?.telemetry.batchTransfer.totalBytes
    ).toBe(12);
  });

  it('rejects malformed embedding telemetry at the host status boundary', () => {
    expect(() =>
      assertEmbeddingHostStatus({
        active: false,
        embeddingRuntime: {
          actualWorkerMetadata: null,
          backendMismatch: false,
          selectedDevicePreference: 'webgpu',
          telemetry: {
            batchTransfer: { batchCount: 0, lastBytes: -1, peakBytes: 0, totalBytes: 0 },
            cache: { entries: [] },
            health: { failureCount: 0, lastFailure: null },
            lastUpdatedAt: null,
            peakVectorsInFlight: 0,
          },
        },
        lastError: null,
        runtimeId: 'embedding-host:runtime-1',
        runtimeKind: 'embedding-host',
        state: 'running',
      })
    ).toThrow('Embedding telemetry batchTransfer.lastBytes must be a non-negative finite number.');
  });
});
