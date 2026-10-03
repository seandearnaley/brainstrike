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

describe('explicit native query inference plan', () => {
  const inferencePlan = {
    device: 'wasm',
    dimensions: 384,
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  } as const;
  const payload = {
    dimensions: 384,
    inferencePlan,
    modelId: inferencePlan.modelId,
    modelKey: 'native:minilm',
    query: 'find callers',
  };

  it('preserves the verified plan unchanged', () => {
    expect(assertEmbeddingHostQueryEmbeddingPayload(payload)).toEqual(payload);
  });
  it.each([
    { inferencePlan: null },
    { inferencePlan: { ...inferencePlan, revision: undefined } },
    { inferencePlan: { ...inferencePlan, device: undefined } },
    { inferencePlan: { ...inferencePlan, dtype: undefined } },
    { inferencePlan: { ...inferencePlan, revision: 'main' } },
    { inferencePlan: { ...inferencePlan, dtype: 'q4' } },
    { modelId: 'selected-model-alias' },
    { dimensions: 768 },
  ])('rejects incomplete, unverified or inconsistent plan %j', (overrides) => {
    expect(() => assertEmbeddingHostQueryEmbeddingPayload({ ...payload, ...overrides })).toThrow();
  });
});

describe('pinned document payload', () => {
  const inferencePlan = {
    device: 'wasm' as const,
    dimensions: 384,
    dtype: 'q8' as const,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  };
  const payload = {
    dimensions: 384,
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
});
