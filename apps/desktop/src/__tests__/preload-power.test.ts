import Module from 'node:module';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
          requestReload: (reason: string) => Promise<void>;
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

  it('does not expose the retired live-query subscription API', () => {
    expect(getElectronApi()).not.toHaveProperty('dbLive');
  });

  it('does not register listeners for retired database updates', () => {
    expect(mockOn.mock.calls.filter(([channel]) => channel === 'db:live-query:update')).toEqual([]);
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
      payload: {
        dimensions: 384,
        modelId: 'embedding-model',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'workspace index benchmark',
      },
      requestId: expect.any(String),
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

  it('exposes the narrow document reload request separately from intent attribution', async () => {
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(undefined);
    const api = getDesktopLifecycleApi();
    if (!api) {
      throw new Error('Desktop lifecycle capability missing');
    }
    await api.requestReload('failed-chunk-recovery');
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(
      'app:lifecycle:request-reload',
      'failed-chunk-recovery'
    );
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
