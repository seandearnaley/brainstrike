import Module from 'node:module';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
type IpcListener = (...args: unknown[]) => void;

const registeredIpcListeners = new Map<string, IpcListener>();
const mockOn = vi.fn<(channel: string, listener: IpcListener) => void>((channel, listener) => {
  registeredIpcListeners.set(channel, listener);
});
const mockRemoveListener = vi.fn<(channel: string, listener: IpcListener) => void>();
const mockExposeInMainWorld = vi.fn<(key: string, api: unknown) => void>();
const mockInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();
const mockSend = vi.fn<(channel: string, ...args: unknown[]) => void>();

const mockElectron = {
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend,
  },
};

type ModuleLoader = (this: typeof Module, id: string, ...rest: unknown[]) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;
moduleWithLoader._load = function (this: typeof Module, id: string, ...rest: unknown[]) {
  if (id === 'electron') {
    return mockElectron;
  }
  return originalLoad.call(this, id, ...rest);
};

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

describe('preload power bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';
    await import('../preload');
  });

  afterAll(() => {
    Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
  });

  function getPowerApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'power');
    return call?.[1] as { onPowerState: (cb: (state: string) => void) => () => void } | undefined;
  }

  function getElectronApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'electronAPI');
    return call?.[1] as
      | {
          dbLive: {
            onUpdate: (cb: (payload: { id: number; results: unknown }) => void) => () => void;
          };
          storage: {
            clear: () => Promise<unknown>;
            setItem: (key: string, value: string) => Promise<unknown>;
          };
        }
      | undefined;
  }

  function getWorkspaceApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'workspace');
    return call?.[1] as { notifyOpenPathReady: () => void } | undefined;
  }

  function getEmbeddingHostApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'embeddingHost');
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
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'chunkingHost');
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
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'llmHost');
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
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'logging');
    return call?.[1] as
      | {
          ingestBufferedRecord: (record: LogRecord) => void;
        }
      | undefined;
  }

  function getDesktopLifecycleApi() {
    const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === 'desktopLifecycle');
    return call?.[1] as
      | {
          isTestMode: boolean;
          noteReloadIntent: (reason: string) => Promise<void>;
        }
      | undefined;
  }

  it('exposes power.onPowerState via contextBridge', () => {
    const powerApi = getPowerApi();
    expect(powerApi).toBeDefined();
    expect(typeof powerApi?.onPowerState).toBe('function');
  });

  it('routes E2E storage reset through the explicit full-clear channel', async () => {
    mockInvoke.mockClear();
    await getElectronApi()?.storage.clear();

    expect(mockInvoke).toHaveBeenCalledWith('storage:clearAllForE2e');
  });

  it('routes only main-owned E2E seed keys through the bounded helper', async () => {
    mockInvoke.mockClear();
    await getElectronApi()?.storage.setItem('rootsList', '[]');
    await getElectronApi()?.storage.setItem('assistant-preferences.v1', '{}');

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'storage:seedMainOwnedForE2e', 'rootsList', '[]');
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      'storage:setItem',
      'assistant-preferences.v1',
      '{}'
    );
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
      ([channel]) => channel === 'app:power-state'
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
      ([channel]) => channel === 'db:live-query:update'
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
      ([channel]) => channel === 'db:live-query:update'
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
        args: ['[preload] db live-query subscriber threw:', subscriberError],
        bindings: { runtime: 'electron-renderer' },
        level: 'error',
        message: 'DB live-query subscriber threw',
        scope: 'Preload',
      })
    );

    throwingCleanup?.();
    healthyCleanup?.();
  });

  it('exposes the embeddingHost lifecycle bridge', async () => {
    mockInvoke.mockResolvedValue({ active: false, lastError: null, state: 'running' });
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

    embeddingHostApi?.reportStatus({ active: true, lastError: null, state: 'running' });
    const cleanupStatus = embeddingHostApi?.onStatus(statusCallback);
    const cleanupCommand = embeddingHostApi?.onCommand(commandCallback);

    expect(mockSend).toHaveBeenCalledWith(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, {
      active: true,
      lastError: null,
      state: 'running',
    });
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(EMBEDDING_HOST_COMMAND_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]) => channel === EMBEDDING_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, status: unknown) => void;
    const commandListener = mockOn.mock.calls.find(
      ([channel]) => channel === EMBEDDING_HOST_COMMAND_EVENT
    )?.[1] as (event: unknown, command: unknown) => void;

    statusListener(null, { active: false, lastError: null, state: 'running' });
    commandListener(null, { type: 'reset' });

    expect(statusCallback).toHaveBeenCalledWith({
      active: false,
      lastError: null,
      state: 'running',
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
    mockInvoke.mockResolvedValue({ active: false, lastError: null, state: 'running' });
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

    chunkingHostApi?.reportStatus({ active: true, lastError: null, state: 'running' });
    chunkingHostApi?.reportResponse({ requestId: 'file-1', result: { ok: true }, type: 'result' });
    const cleanupStatus = chunkingHostApi?.onStatus(statusCallback);
    const cleanupProgress = chunkingHostApi?.onProgress(progressCallback);
    const cleanupRequest = chunkingHostApi?.onRequest(requestCallback);

    expect(mockSend).toHaveBeenCalledWith(CHUNKING_HOST_REPORT_STATUS_CHANNEL, {
      active: true,
      lastError: null,
      state: 'running',
    });
    expect(mockSend).toHaveBeenCalledWith(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, {
      requestId: 'file-1',
      result: { ok: true },
      type: 'result',
    });
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_STATUS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_PROGRESS_EVENT, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(CHUNKING_HOST_REQUEST_EVENT, expect.any(Function));

    const statusListener = mockOn.mock.calls.find(
      ([channel]) => channel === CHUNKING_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, status: unknown) => void;
    const progressListener = mockOn.mock.calls.find(
      ([channel]) => channel === CHUNKING_HOST_PROGRESS_EVENT
    )?.[1] as (event: unknown, progress: unknown) => void;
    const requestListener = mockOn.mock.calls.find(
      ([channel]) => channel === CHUNKING_HOST_REQUEST_EVENT
    )?.[1] as (event: unknown, request: unknown) => void;

    statusListener(null, { active: false, lastError: null, state: 'running' });
    progressListener(null, { fileRecordId: 'file-1', requestId: 'batch-1', type: 'progress' });
    requestListener(null, { fileRecordId: 'file-1', kind: 'chunk-file', requestId: 'file-1' });

    expect(statusCallback).toHaveBeenCalledWith({
      active: false,
      lastError: null,
      state: 'running',
    });
    expect(progressCallback).toHaveBeenCalledWith({
      fileRecordId: 'file-1',
      requestId: 'batch-1',
      type: 'progress',
    });
    expect(requestCallback).toHaveBeenCalledWith({
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      requestId: 'file-1',
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
    mockInvoke.mockResolvedValue({ active: false, lastError: null, state: 'running' });
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
      messages: [{ content: 'hello', role: 'user' }],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      options: { temperature: 0 },
      requestId: 'generate-1',
    });

    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_ENSURE_STARTED_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_STOP_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_RESET_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_GET_STATUS_CHANNEL);
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_CANCEL_CHANNEL, 'cancel-1');
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_WARMUP_CHANNEL, {
      clientRequestId: 'warmup-1',
      kind: 'warmup',
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });
    expect(mockInvoke).toHaveBeenCalledWith(LLM_HOST_GENERATE_CHANNEL, {
      clientRequestId: 'generate-1',
      kind: 'generate',
      messages: [{ content: 'hello', role: 'user' }],
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
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

    const status = { active: true, lastError: null, state: 'running' };
    const progress = {
      channel: 'llm-progress',
      payload: { kind: 'text', text: 'hi' },
      requestId: 'generate-1',
      runtimeId: 'runtime-1',
      type: 'progress',
    };
    const response = {
      channel: 'llm-result',
      payload: { result: null },
      requestId: 'generate-1',
      runtimeId: 'runtime-1',
      type: 'result',
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
      ([channel]) => channel === LLM_HOST_STATUS_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;
    const progressListener = mockOn.mock.calls.find(
      ([channel]) => channel === LLM_HOST_PROGRESS_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;
    const requestListener = mockOn.mock.calls.find(
      ([channel]) => channel === LLM_HOST_REQUEST_EVENT
    )?.[1] as (event: unknown, payload: unknown) => void;

    statusListener(null, { active: false, lastError: null, state: 'idle' });
    progressListener(null, progress);
    requestListener(null, { channel: 'llm', payload: { kind: 'warmup' }, type: 'request' });

    expect(statusCallback).toHaveBeenCalledWith({ active: false, lastError: null, state: 'idle' });
    expect(progressCallback).toHaveBeenCalledWith(progress);
    expect(requestCallback).toHaveBeenCalledWith({
      channel: 'llm',
      payload: { kind: 'warmup' },
      type: 'request',
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
      args: ['forwarded'],
      bindings: { runtime: 'electron-renderer' },
      level: LogLevel.INFO,
      message: 'forwarded',
      scope: 'EmbeddingHostRuntime',
      timestamp: 123,
    });

    expect(mockSend).toHaveBeenCalledWith('logging:ingest-buffered-record', {
      args: ['forwarded'],
      bindings: { runtime: 'electron-renderer' },
      level: 'info',
      message: 'forwarded',
      scope: 'EmbeddingHostRuntime',
      timestamp: 123,
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

  it('echoes the main-issued factory-reset generation in the renderer-ready ping', () => {
    mockSend.mockClear();
    const generationListener = registeredIpcListeners.get('workspace:factory-reset-generation');
    expect(generationListener).toBeDefined();

    generationListener?.(null, { resetGeneration: 'reset-generation-1' });
    getWorkspaceApi()?.notifyOpenPathReady();

    expect(mockSend).toHaveBeenCalledWith('workspace:open-path-ready', {
      resetGeneration: 'reset-generation-1',
    });
  });
});
