import Module from 'node:module';
import type { LogRecord } from '@brainstrike/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
  CHUNKING_HOST_CHUNK_FILE_CHANNEL,
  CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
  CHUNKING_HOST_GET_STATUS_CHANNEL,
  CHUNKING_HOST_PROGRESS_EVENT,
  CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
  CHUNKING_HOST_REPORT_STATUS_CHANNEL,
  CHUNKING_HOST_REQUEST_EVENT,
  CHUNKING_HOST_RESET_CHANNEL,
  CHUNKING_HOST_STATUS_EVENT,
  CHUNKING_HOST_STOP_CHANNEL,
} from '../chunking-host-shared';
import {
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOP_CHANNEL,
} from '../embedding-host-shared';
import {
  LLM_HOST_CANCEL_CHANNEL,
  LLM_HOST_ENSURE_STARTED_CHANNEL,
  LLM_HOST_GENERATE_CHANNEL,
  LLM_HOST_GET_STATUS_CHANNEL,
  LLM_HOST_PROGRESS_EVENT,
  LLM_HOST_REPORT_PROGRESS_CHANNEL,
  LLM_HOST_REPORT_RESPONSE_CHANNEL,
  LLM_HOST_REPORT_STATUS_CHANNEL,
  LLM_HOST_REQUEST_EVENT,
  LLM_HOST_RESET_CHANNEL,
  LLM_HOST_STATUS_EVENT,
  LLM_HOST_STOP_CHANNEL,
  LLM_HOST_WARMUP_CHANNEL,
} from '../llm-host-shared';

// CJS require('electron') in preload.ts resolves via Node's native module loader,
// which returns the Electron binary path (a string), not the API object.
// vi.mock only intercepts ESM import(), so we must patch Module._load for CJS.
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn();
const mockSend = vi.fn();

const mockElectron = {
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend,
  },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
};

const originalLoad = Module._load;
// @ts-expect-error -- Module._load signature is internal
Module._load = function (id: string, ...rest: unknown[]) {
  if (id === 'electron') {
    return mockElectron;
  }
  // @ts-expect-error -- forwarding to original
  return originalLoad.call(this, id, ...rest);
};

afterAll(() => {
  Module._load = originalLoad;
});

describe('preload power bridge', () => {
  beforeAll(async () => {
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';
    await import('../preload');
  });

  afterAll(() => {
    process.env['ELECTRON_IS_E2E_TEST'] = undefined;
  });

  function getPowerApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'power');
    return call?.[1] as { onPowerState: (cb: (state: string) => void) => () => void } | undefined;
  }

  function getElectronApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'electronAPI');
    return call?.[1] as
      | {
          dbLive: {
            onUpdate: (cb: (payload: { id: number; results: unknown }) => void) => () => void;
          };
        }
      | undefined;
  }

  function getEmbeddingHostApi() {
    const call = mockExposeInMainWorld.mock.calls.find(
      ([key]: [string]) => key === 'embeddingHost'
    );
    return call?.[1] as
      | {
          ensureStarted: () => Promise<unknown>;
          stop: () => Promise<unknown>;
          reset: () => Promise<unknown>;
          getStatus: () => Promise<unknown>;
          queryEmbedding: (payload: unknown) => Promise<unknown>;
          reportStatus: (status: unknown) => void;
          onStatus: (cb: (status: unknown) => void) => () => void;
          onCommand: (cb: (command: unknown) => void) => () => void;
        }
      | undefined;
  }

  function getChunkingHostApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'chunkingHost');
    return call?.[1] as
      | {
          ensureStarted: () => Promise<unknown>;
          stop: () => Promise<unknown>;
          reset: () => Promise<unknown>;
          getStatus: () => Promise<unknown>;
          chunkFile: (request: unknown) => Promise<unknown>;
          chunkBatch: (request: unknown) => Promise<unknown>;
          reportStatus: (status: unknown) => void;
          reportResponse: (response: unknown) => void;
          onStatus: (cb: (status: unknown) => void) => () => void;
          onProgress: (cb: (progress: unknown) => void) => () => void;
          onRequest: (cb: (request: unknown) => void) => () => void;
        }
      | undefined;
  }

  function getLlmHostApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'llmHost');
    return call?.[1] as
      | {
          ensureStarted: () => Promise<unknown>;
          stop: () => Promise<unknown>;
          reset: () => Promise<unknown>;
          getStatus: () => Promise<unknown>;
          cancel: (requestId: string) => Promise<unknown>;
          warmup: (payload: { modelId: string; requestId?: string } | string) => Promise<unknown>;
          generate: (payload: {
            requestId?: string;
            modelId: string;
            messages: unknown[];
            options?: unknown;
          }) => Promise<unknown>;
          reportStatus: (status: unknown) => void;
          reportProgress: (progress: unknown) => void;
          reportResponse: (response: unknown) => void;
          onStatus: (cb: (status: unknown) => void) => () => void;
          onProgress: (cb: (progress: unknown) => void) => () => void;
          onRequest: (cb: (request: unknown) => void) => () => void;
        }
      | undefined;
  }

  function getLoggingApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]: [string]) => key === 'logging');
    return call?.[1] as
      | {
          ingestBufferedRecord: (record: LogRecord) => void;
        }
      | undefined;
  }

  function getDesktopLifecycleApi() {
    const call = mockExposeInMainWorld.mock.calls.find(
      ([key]: [string]) => key === 'desktopLifecycle'
    );
    return call?.[1] as
      | {
          noteReloadIntent: (reason: string) => Promise<void>;
        }
      | undefined;
  }

  it('exposes power.onPowerState via contextBridge', () => {
    const powerApi = getPowerApi();
    expect(powerApi).toBeDefined();
    expect(typeof powerApi?.onPowerState).toBe('function');
  });

  it('subscribes to app:power-state IPC channel', () => {
    mockOn.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    powerApi?.onPowerState(cb);
    expect(mockOn).toHaveBeenCalledWith('app:power-state', expect.any(Function));
  });

  it('forwards power state string to callback', () => {
    mockOn.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    powerApi?.onPowerState(cb);

    const ipcListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === 'app:power-state'
    )?.[1] as (event: unknown, state: string) => void;

    ipcListener(null, 'suspend');
    expect(cb).toHaveBeenCalledWith('suspend');

    ipcListener(null, 'resume');
    expect(cb).toHaveBeenCalledWith('resume');
  });

  it('cleanup function removes the IPC listener', () => {
    mockRemoveListener.mockClear();
    const powerApi = getPowerApi();
    const cb = vi.fn();
    const cleanup = powerApi?.onPowerState(cb);

    cleanup?.();
    expect(mockRemoveListener).toHaveBeenCalledWith('app:power-state', expect.any(Function));
  });

  it('multiplexes db live-query updates through one IPC listener', () => {
    mockOn.mockClear();
    mockRemoveListener.mockClear();

    const electronApi = getElectronApi();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const firstCleanup = electronApi?.dbLive.onUpdate(firstCallback);
    const secondCleanup = electronApi?.dbLive.onUpdate(secondCallback);

    const updateSubscriptions = mockOn.mock.calls.filter(
      ([channel]: [string]) => channel === 'db:live-query:update'
    );
    expect(updateSubscriptions).toHaveLength(1);

    const listener = updateSubscriptions[0]?.[1] as
      | ((event: unknown, payload: { id: number; results: unknown }) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.(null, { id: 17, results: { rows: [{ id: 'row-1' }] } });
    expect(firstCallback).toHaveBeenCalledWith({ id: 17, results: { rows: [{ id: 'row-1' }] } });
    expect(secondCallback).toHaveBeenCalledWith({ id: 17, results: { rows: [{ id: 'row-1' }] } });

    firstCleanup?.();
    expect(mockRemoveListener).not.toHaveBeenCalledWith(
      'db:live-query:update',
      expect.any(Function)
    );

    secondCleanup?.();
    expect(mockRemoveListener).toHaveBeenCalledWith('db:live-query:update', expect.any(Function));
  });

  it('isolates db live-query subscriber errors and logs them', () => {
    mockOn.mockClear();
    mockRemoveListener.mockClear();
    mockSend.mockClear();

    const electronApi = getElectronApi();
    const subscriberError = new Error('subscriber failed');
    const throwingCallback = vi.fn(() => {
      throw subscriberError;
    });
    const healthyCallback = vi.fn();
    const throwingCleanup = electronApi?.dbLive.onUpdate(throwingCallback);
    const healthyCleanup = electronApi?.dbLive.onUpdate(healthyCallback);

    const updateSubscriptions = mockOn.mock.calls.filter(
      ([channel]: [string]) => channel === 'db:live-query:update'
    );
    expect(updateSubscriptions).toHaveLength(1);

    const listener = updateSubscriptions[0]?.[1] as
      | ((event: unknown, payload: { id: number; results: unknown }) => void)
      | undefined;
    expect(listener).toBeDefined();

    const payload = { id: 23, results: { rows: [{ id: 'row-2' }] } };
    expect(() => listener?.(null, payload)).not.toThrow();
    expect(throwingCallback).toHaveBeenCalledWith(payload);
    expect(healthyCallback).toHaveBeenCalledWith(payload);
    expect(mockSend).toHaveBeenCalledWith(
      'logging:ingest-buffered-record',
      expect.objectContaining({
        level: 'error',
        args: ['[preload] db live-query subscriber threw:', subscriberError],
        bindings: { runtime: 'electron-renderer' },
        message: 'DB live-query subscriber threw',
        scope: 'Preload',
      })
    );

    throwingCleanup?.();
    healthyCleanup?.();
  });

  it('exposes the embeddingHost lifecycle bridge', async () => {
    mockInvoke.mockResolvedValue({ state: 'running', active: false, lastError: null });
    const embeddingHostApi = getEmbeddingHostApi();
    expect(embeddingHostApi).toBeDefined();

    await embeddingHostApi?.ensureStarted();
    await embeddingHostApi?.stop();
    await embeddingHostApi?.reset();
    await embeddingHostApi?.getStatus();
    await embeddingHostApi?.queryEmbedding({
      dimensions: 384,
      modelId: 'embedding-model',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'workspace index benchmark',
    });

    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_STOP_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_RESET_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_GET_STATUS_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL, {
      dimensions: 384,
      modelId: 'embedding-model',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'workspace index benchmark',
    });
  });

  it('rejects invalid embeddingHost query payloads before IPC', async () => {
    mockInvoke.mockClear();
    const embeddingHostApi = getEmbeddingHostApi();
    expect(embeddingHostApi).toBeDefined();
    if (!embeddingHostApi) {
      throw new Error('embeddingHost bridge unavailable');
    }

    expect(() =>
      embeddingHostApi.queryEmbedding({
        dimensions: 0,
        modelId: 'embedding-model',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'workspace index benchmark',
      })
    ).toThrow('Embedding host query embedding payload.dimensions must be a positive integer.');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('forwards embedding host reports and subscribes to host events', () => {
    mockOn.mockClear();
    mockSend.mockClear();
    mockRemoveListener.mockClear();

    const embeddingHostApi = getEmbeddingHostApi();
    const statusCallback = vi.fn();
    const commandCallback = vi.fn();

    embeddingHostApi?.reportStatus({ state: 'running', active: true, lastError: null });
    const cleanupStatus = embeddingHostApi?.onStatus(statusCallback);
    const cleanupCommand = embeddingHostApi?.onCommand(commandCallback);

    expect(mockSend).toHaveBeenCalledWith(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, {
      state: 'running',
      active: true,
      lastError: null,
    });
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_COMMAND_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === EMBEDDING_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, status: unknown) => void;
    const commandListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === EMBEDDING_HOST_COMMAND_EVENT
    )?.[1] as (event: unknown, command: unknown) => void;

    statusListener(null, { state: 'running', active: false, lastError: null });
    commandListener(null, { type: 'reset' });

    expect(statusCallback).toHaveBeenCalledWith({
      state: 'running',
      active: false,
      lastError: null,
    });
    expect(commandCallback).toHaveBeenCalledWith({ type: 'reset' });

    cleanupStatus?.();
    cleanupCommand?.();

    expect(mockRemoveListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_STATUS_EVENT,
      expect.any(Function)
    );
    expect(mockRemoveListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_COMMAND_EVENT,
      expect.any(Function)
    );
  });

  it('exposes the chunkingHost lifecycle and request bridge', async () => {
    mockInvoke.mockResolvedValue({ state: 'running', active: false, lastError: null });
    const chunkingHostApi = getChunkingHostApi();
    expect(chunkingHostApi).toBeDefined();

    await chunkingHostApi?.ensureStarted();
    await chunkingHostApi?.stop();
    await chunkingHostApi?.reset();
    await chunkingHostApi?.getStatus();
    await chunkingHostApi?.chunkFile({ kind: 'chunk-file', requestId: 'file-1' });
    await chunkingHostApi?.chunkBatch({ kind: 'chunk-batch', requestId: 'batch-1' });

    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_ENSURE_STARTED_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_STOP_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_RESET_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_GET_STATUS_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_CHUNK_FILE_CHANNEL, {
      kind: 'chunk-file',
      requestId: 'file-1',
    });
    expect(mockInvoke).toHaveBeenCalledWith(CHUNKING_HOST_CHUNK_BATCH_CHANNEL, {
      kind: 'chunk-batch',
      requestId: 'batch-1',
    });
  });

  it('forwards chunking host status, progress, requests, and responses', () => {
    mockOn.mockClear();
    mockSend.mockClear();
    mockRemoveListener.mockClear();

    const chunkingHostApi = getChunkingHostApi();
    const statusCallback = vi.fn();
    const progressCallback = vi.fn();
    const requestCallback = vi.fn();

    chunkingHostApi?.reportStatus({ state: 'running', active: true, lastError: null });
    chunkingHostApi?.reportResponse({ type: 'result', requestId: 'file-1', result: { ok: true } });
    const cleanupStatus = chunkingHostApi?.onStatus(statusCallback);
    const cleanupProgress = chunkingHostApi?.onProgress(progressCallback);
    const cleanupRequest = chunkingHostApi?.onRequest(requestCallback);

    expect(mockSend).toHaveBeenCalledWith(CHUNKING_HOST_REPORT_STATUS_CHANNEL, {
      state: 'running',
      active: true,
      lastError: null,
    });
    expect(mockSend).toHaveBeenCalledWith(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, {
      type: 'result',
      requestId: 'file-1',
      result: { ok: true },
    });
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_PROGRESS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_REQUEST_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === CHUNKING_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, status: unknown) => void;
    const progressListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === CHUNKING_HOST_PROGRESS_EVENT
    )?.[1] as (event: unknown, progress: unknown) => void;
    const requestListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === CHUNKING_HOST_REQUEST_EVENT
    )?.[1] as (event: unknown, request: unknown) => void;

    statusListener(null, { state: 'running', active: false, lastError: null });
    progressListener(null, { type: 'progress', requestId: 'batch-1', fileRecordId: 'file-1' });
    requestListener(null, { kind: 'chunk-file', requestId: 'file-1', fileRecordId: 'file-1' });

    expect(statusCallback).toHaveBeenCalledWith({
      state: 'running',
      active: false,
      lastError: null,
    });
    expect(progressCallback).toHaveBeenCalledWith({
      type: 'progress',
      requestId: 'batch-1',
      fileRecordId: 'file-1',
    });
    expect(requestCallback).toHaveBeenCalledWith({
      kind: 'chunk-file',
      requestId: 'file-1',
      fileRecordId: 'file-1',
    });

    cleanupStatus?.();
    cleanupProgress?.();
    cleanupRequest?.();

    expect(mockRemoveListener).toHaveBeenCalledWith(
      CHUNKING_HOST_STATUS_EVENT,
      expect.any(Function)
    );
    expect(mockRemoveListener).toHaveBeenCalledWith(
      CHUNKING_HOST_PROGRESS_EVENT,
      expect.any(Function)
    );
    expect(mockRemoveListener).toHaveBeenCalledWith(
      CHUNKING_HOST_REQUEST_EVENT,
      expect.any(Function)
    );
  });

  it('exposes the llmHost lifecycle and request bridge', async () => {
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue({ state: 'running', active: false, lastError: null });
    const llmHostApi = getLlmHostApi();
    expect(llmHostApi).toBeDefined();

    await llmHostApi?.ensureStarted();
    await llmHostApi?.stop();
    await llmHostApi?.reset();
    await llmHostApi?.getStatus();
    await llmHostApi?.cancel('cancel-1');
    await llmHostApi?.warmup({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      requestId: 'warmup-1',
    });
    await llmHostApi?.generate({
      requestId: 'generate-1',
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      messages: [{ role: 'user', content: 'hello' }],
      options: { temperature: 0 },
    });

    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_ENSURE_STARTED_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_STOP_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_RESET_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_GET_STATUS_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_CANCEL_CHANNEL, 'cancel-1');
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_WARMUP_CHANNEL, {
      kind: 'warmup',
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      clientRequestId: 'warmup-1',
    });
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_GENERATE_CHANNEL, {
      kind: 'generate',
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      clientRequestId: 'generate-1',
      messages: [{ role: 'user', content: 'hello' }],
      options: { temperature: 0 },
    });
  });

  it('forwards llm host status, progress, requests, and responses', () => {
    mockOn.mockClear();
    mockSend.mockClear();
    mockRemoveListener.mockClear();

    const llmHostApi = getLlmHostApi();
    const statusCallback = vi.fn();
    const progressCallback = vi.fn();
    const requestCallback = vi.fn();

    const status = { state: 'running', active: true, lastError: null };
    const progress = {
      type: 'progress',
      channel: 'llm-progress',
      requestId: 'generate-1',
      runtimeId: 'runtime-1',
      payload: { kind: 'text', text: 'hi' },
    };
    const response = {
      type: 'result',
      channel: 'llm-result',
      requestId: 'generate-1',
      runtimeId: 'runtime-1',
      payload: { result: null },
    };

    llmHostApi?.reportStatus(status);
    llmHostApi?.reportProgress(progress);
    llmHostApi?.reportResponse(response);
    const cleanupStatus = llmHostApi?.onStatus(statusCallback);
    const cleanupProgress = llmHostApi?.onProgress(progressCallback);
    const cleanupRequest = llmHostApi?.onRequest(requestCallback);

    expect(mockSend).toHaveBeenCalledWith(LLM_HOST_REPORT_STATUS_CHANNEL, status);
    expect(mockSend).toHaveBeenCalledWith(LLM_HOST_REPORT_PROGRESS_CHANNEL, progress);
    expect(mockSend).toHaveBeenCalledWith(LLM_HOST_REPORT_RESPONSE_CHANNEL, response);
    expect(mockOn).toHaveBeenCalledWith(LLM_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(LLM_HOST_PROGRESS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(LLM_HOST_REQUEST_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === LLM_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;
    const progressListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === LLM_HOST_PROGRESS_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;
    const requestListener = mockOn.mock.calls.find(
      ([channel]: [string]) => channel === LLM_HOST_REQUEST_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;

    statusListener(null, { state: 'idle', active: false, lastError: null });
    progressListener(null, progress);
    requestListener(null, { type: 'request', channel: 'llm', payload: { kind: 'warmup' } });

    expect(statusCallback).toHaveBeenCalledWith({ state: 'idle', active: false, lastError: null });
    expect(progressCallback).toHaveBeenCalledWith(progress);
    expect(requestCallback).toHaveBeenCalledWith({
      type: 'request',
      channel: 'llm',
      payload: { kind: 'warmup' },
    });

    cleanupStatus?.();
    cleanupProgress?.();
    cleanupRequest?.();

    expect(mockRemoveListener).toHaveBeenCalledWith(LLM_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockRemoveListener).toHaveBeenCalledWith(LLM_HOST_PROGRESS_EVENT, expect.any(Function));
    expect(mockRemoveListener).toHaveBeenCalledWith(LLM_HOST_REQUEST_EVENT, expect.any(Function));
  });

  it('exposes logging buffered-record ingestion bridge', () => {
    mockSend.mockClear();
    const loggingApi = getLoggingApi();
    expect(loggingApi).toBeDefined();

    loggingApi?.ingestBufferedRecord({
      level: 'info',
      timestamp: 123,
      args: ['forwarded'],
      bindings: { runtime: 'electron-renderer' },
      message: 'forwarded',
      scope: 'EmbeddingHostRuntime',
    });

    expect(mockSend).toHaveBeenCalledWith('logging:ingest-buffered-record', {
      level: 'info',
      timestamp: 123,
      args: ['forwarded'],
      bindings: { runtime: 'electron-renderer' },
      message: 'forwarded',
      scope: 'EmbeddingHostRuntime',
    });
  });

  it('exposes a renderer reload-intent bridge for desktop lifecycle attribution', async () => {
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(undefined);
    const desktopLifecycleApi = getDesktopLifecycleApi();
    expect(desktopLifecycleApi).toBeDefined();
    expect(desktopLifecycleApi?.isTestMode).toBe(true);

    await desktopLifecycleApi?.noteReloadIntent('factory-reset');

    expect(mockInvoke).toHaveBeenCalledWith('app:lifecycle:note-reload-intent', 'factory-reset');
  });
});
