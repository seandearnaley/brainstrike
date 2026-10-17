import { EmbeddingDeviceLostError } from '@brainstrike/indexing-contract';
import { deserializeRuntimeError } from '@brainstrike/worker-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingHostCommand,
  assertEmbeddingHostDocumentEmbeddingsPayload,
  assertEmbeddingHostDocumentEmbeddingsResponseReport,
  assertEmbeddingHostQueryEmbeddingCancel,
  assertEmbeddingHostQueryEmbeddingPayload,
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  createEmbeddingHostCommand,
  createEmbeddingHostDocumentCancellationError,
  createEmbeddingHostDocumentEmbeddingsErrorReport,
  createEmbeddingHostDocumentEmbeddingsProgressReport,
  createEmbeddingHostDocumentEmbeddingsRequest,
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingCancel,
  createEmbeddingHostQueryEmbeddingErrorReport,
  createEmbeddingHostQueryEmbeddingRequest,
  EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
  EMBEDDING_HOST_QUERY_CANCELED_CODE,
} from '../embedding-host-shared';

describe('embedding host shared command helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves typed device loss across the renderer to Main error envelope', () => {
    const request = createEmbeddingHostQueryEmbeddingRequest('runtime-a', {
      dimensions: 2,
      modelId: 'model-a',
      modelKey: 'local:model-a',
      query: 'fixture',
    });
    const report = assertEmbeddingHostQueryEmbeddingResponseReport(
      JSON.parse(
        JSON.stringify(
          createEmbeddingHostQueryEmbeddingErrorReport(
            request,
            new EmbeddingDeviceLostError('destroyed: adapter reset')
          )
        )
      )
    );
    expect(deserializeRuntimeError(report.payload)).toMatchObject({
      cause: 'destroyed: adapter reset',
      code: 'EMBEDDING_DEVICE_LOST',
      name: 'DeviceLost',
    });
  });

  it('carries only exact request and runtime identity in a cancellation notice', () => {
    const request = createEmbeddingHostQueryEmbeddingRequest('runtime-a', {
      dimensions: 2,
      modelId: 'model-a',
      modelKey: 'local:model-a',
      query: 'private query content',
    });
    const notice = createEmbeddingHostQueryEmbeddingCancel(request);
    expect(assertEmbeddingHostQueryEmbeddingCancel(notice)).toEqual({
      channel: 'query-embedding-cancel',
      payload: {},
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'request',
    });
    expect(JSON.stringify(notice)).not.toContain(request.payload.query);
    for (const invalid of [
      { ...notice, payload: { query: request.payload.query } },
      { ...notice, type: 'result' },
      { ...notice, channel: 'query-embedding' },
      { ...notice, runtimeId: '' },
      { ...notice, requestId: '' },
    ]) {
      expect(() => assertEmbeddingHostQueryEmbeddingCancel(invalid)).toThrow();
    }
  });

  it('retains the exact query cancellation code through the terminal IPC envelope', () => {
    const request = createEmbeddingHostQueryEmbeddingRequest('runtime-a', {
      dimensions: 2,
      modelId: 'model-a',
      modelKey: 'local:model-a',
      query: 'fixture',
    });
    const report = assertEmbeddingHostQueryEmbeddingResponseReport(
      JSON.parse(
        JSON.stringify(
          createEmbeddingHostQueryEmbeddingErrorReport(
            request,
            createEmbeddingHostQueryCancellationError()
          )
        )
      )
    );
    expect(report).toMatchObject({
      payload: { code: EMBEDDING_HOST_QUERY_CANCELED_CODE, name: 'AbortError' },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'error',
    });
    const independent = assertEmbeddingHostQueryEmbeddingResponseReport(
      createEmbeddingHostQueryEmbeddingErrorReport(
        request,
        new DOMException('independent abort', 'AbortError')
      )
    );
    expect(independent.payload).not.toHaveProperty('code');
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
    ).toThrow(
      'Embedding host command payload.action must be "reset", "resolve-device", "start-background" or "stop".'
    );
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

  it('round-trips a resolve-device command, which carries no next runtime', () => {
    const command = createEmbeddingHostCommand('resolve-device', 'embedding-host:runtime-1');
    expect(assertEmbeddingHostCommand(command)).toEqual(command);
    expect(() =>
      assertEmbeddingHostCommand({
        ...command,
        payload: { action: 'resolve-device', nextRuntimeId: 'x' },
      })
    ).toThrow('must not include payload.nextRuntimeId');
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

  it('carries the device the host resolved at start across the status boundary', () => {
    const status = (hostDevice: unknown) => ({
      active: false,
      embeddingRuntime: {
        actualWorkerMetadata: null,
        backendMismatch: false,
        hostDevice,
        selectedDevicePreference: 'webgpu',
        telemetry: {
          batchTransfer: { batchCount: 0, lastBytes: 0, peakBytes: 0, totalBytes: 0 },
          cache: {
            entries: [],
            estimatedGpuBytes: 0,
            estimatedHeapBytes: 0,
            memoryEstimateUnavailableCount: 0,
            residentCount: 0,
          },
          health: { failureCount: 0, lastFailure: null },
          lastUpdatedAt: null,
          peakVectorsInFlight: 0,
        },
      },
      lastError: null,
      runtimeId: 'embedding-host:runtime-1',
      runtimeKind: 'embedding-host',
      state: 'running',
    });
    expect(assertEmbeddingHostStatus(status('wasm')).embeddingRuntime?.hostDevice).toBe('wasm');
    expect(() => assertEmbeddingHostStatus(status('cpu'))).toThrow(
      'Embedding host status embeddingRuntime.hostDevice must be "webgpu" or "wasm".'
    );
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

describe('explicit native query inference plan', () => {
  const inferencePlan = {
    device: 'wasm',
    dimensions: 768,
    dtype: 'q4',
    modelId: 'jinaai/jina-embeddings-v2-base-code',
  } as const;
  const payload = {
    dimensions: 768,
    inferencePlan,
    modelId: inferencePlan.modelId,
    modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
    query: 'find callers',
  };

  it('preserves the catalog plan with optional revision and q4 unchanged', () => {
    expect(assertEmbeddingHostQueryEmbeddingPayload(payload)).toEqual(payload);
  });
  it.each([
    { inferencePlan: null },
    { inferencePlan: { ...inferencePlan, device: undefined } },
    { inferencePlan: { ...inferencePlan, dtype: undefined } },
    { inferencePlan: { ...inferencePlan, revision: 'main' } },
    { inferencePlan: { ...inferencePlan, dtype: 'invalid' } },
    { modelId: 'selected-model-alias' },
    { dimensions: 384 },
  ])('rejects incomplete, unverified or inconsistent plan %j', (overrides) => {
    expect(() => assertEmbeddingHostQueryEmbeddingPayload({ ...payload, ...overrides })).toThrow();
  });
});

describe('catalog document payload', () => {
  const inferencePlan = {
    device: 'wasm' as const,
    dimensions: 768,
    dtype: 'q8' as const,
    modelId: 'Xenova/bge-base-en-v1.5',
  };
  const payload = {
    dimensions: 768,
    inferencePlan,
    modelId: inferencePlan.modelId,
    modelKey: 'native:documents',
    texts: ['  document text\n', 'second document'],
  };
  it('preserves document text and full plan', () => {
    expect(assertEmbeddingHostDocumentEmbeddingsPayload(payload)).toEqual(payload);
  });
  it('preserves the exact host cancellation code through the validated terminal envelope', () => {
    const request = createEmbeddingHostDocumentEmbeddingsRequest(
      'runtime',
      assertEmbeddingHostDocumentEmbeddingsPayload(payload)
    );
    const report = assertEmbeddingHostDocumentEmbeddingsResponseReport(
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        createEmbeddingHostDocumentCancellationError()
      )
    );
    expect(report).toMatchObject({
      payload: { code: EMBEDDING_HOST_DOCUMENT_CANCELED_CODE, name: 'AbortError' },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'error',
    });
    expect(
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        new DOMException('independent abort', 'AbortError')
      )
    ).toMatchObject({ payload: { name: 'AbortError' } });
    expect(
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request,
        new DOMException('independent abort', 'AbortError')
      ).payload
    ).not.toHaveProperty('code');
  });
  it.each([
    { ...payload, inferencePlan: undefined },
    { ...payload, inferencePlan: { ...inferencePlan, revision: 'main' } },
    { ...payload, texts: [] },
    { ...payload, texts: [''] },
    { ...payload, texts: [' '] },
    { ...payload, texts: Array.from({ length: 65 }, () => 'document') },
    { ...payload, dimensions: 2 },
  ])('refuses unresolved plans and invalid batches', (invalid) => {
    expect(() => assertEmbeddingHostDocumentEmbeddingsPayload(invalid)).toThrow();
  });
  it('carries model setup and slice progress as validated liveness (BST-2104)', () => {
    const request = createEmbeddingHostDocumentEmbeddingsRequest(
      'runtime',
      assertEmbeddingHostDocumentEmbeddingsPayload(payload)
    );
    for (const progress of [
      { stage: 'setup' as const },
      { completed: 0, stage: 'inference' as const },
      { completed: 64, stage: 'inference' as const },
    ]) {
      expect(
        assertEmbeddingHostDocumentEmbeddingsResponseReport(
          createEmbeddingHostDocumentEmbeddingsProgressReport(request, progress)
        )
      ).toMatchObject({ payload: progress, requestId: request.requestId, type: 'progress' });
    }
  });
  it.each([
    {},
    { completed: 1 },
    { completed: 0, stage: 'setup' },
    { completed: -1, stage: 'inference' },
    { completed: 65, stage: 'inference' },
    { completed: 1.5, stage: 'inference' },
    { stage: 'download' },
  ])('refuses malformed document progress %j', (progress) => {
    expect(() =>
      assertEmbeddingHostDocumentEmbeddingsResponseReport({
        channel: 'document-embeddings-progress',
        payload: progress,
        requestId: 'request',
        runtimeId: 'runtime',
        type: 'progress',
      })
    ).toThrow('Invalid document embeddings progress.');
  });
});
