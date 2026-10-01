import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, listeners, removeListener, removeHandler } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const typedIpcMain = electronUtils.createIpcMainMock();
  typedIpcMain.handle.mockImplementation(
    (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }
  );
  const on = vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    listeners.set(channel, listener);
  });

  return {
    ipcMain: Object.assign(typedIpcMain, {
      on,
      removeHandler,
      removeListener,
    }),
  };
});

import {
  EMBEDDING_HOST_DOWNLOAD_MODEL_CHANNEL,
  EMBEDDING_HOST_DOWNLOAD_PROGRESS_EVENT,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
  EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STOP_CHANNEL,
} from '../../embedding-host-shared';
import { registerEmbeddingHostIpcHandlers } from '../../ipc-embedding-host';

describe('embedding host IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    vi.clearAllMocks();
  });

  it('registers lifecycle handlers and forwards valid status reports', async () => {
    const manager = {
      acceptQueryEmbeddingResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn().mockResolvedValue({ state: 'running' }),
      getStatus: vi.fn().mockResolvedValue({ state: 'running' }),
      queryEmbedding: vi.fn(),
      reset: vi.fn().mockResolvedValue({ state: 'running' }),
      stop: vi.fn().mockResolvedValue({ state: 'stopped' }),
    };

    registerEmbeddingHostIpcHandlers(manager as never);

    const ensureStartedHandler = handlers.get(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    const getStatusHandler = handlers.get(EMBEDDING_HOST_GET_STATUS_CHANNEL);
    const resetHandler = handlers.get(EMBEDDING_HOST_RESET_CHANNEL);
    const stopHandler = handlers.get(EMBEDDING_HOST_STOP_CHANNEL);
    const statusListener = listeners.get(EMBEDDING_HOST_REPORT_STATUS_CHANNEL);

    if (
      !(ensureStartedHandler && getStatusHandler && resetHandler && stopHandler && statusListener)
    ) {
      throw new Error('Embedding host lifecycle handlers were not fully registered.');
    }

    await ensureStartedHandler();
    await getStatusHandler();
    await resetHandler();
    await stopHandler();

    statusListener(
      { sender: { id: 17 } },
      {
        active: true,
        lastError: null,
        runtimeId: 'embedding-host:runtime-1',
        runtimeKind: 'embedding-host',
        state: 'running',
      }
    );

    expect(manager.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
    expect(manager.getStatus).toHaveBeenCalledTimes(1);
    expect(manager.reset).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.acceptStatusReport).toHaveBeenCalledWith(17, {
      active: true,
      lastError: null,
      runtimeId: 'embedding-host:runtime-1',
      runtimeKind: 'embedding-host',
      state: 'running',
    });
  });

  it('fails fast on malformed embedding status reports', () => {
    const manager = {
      acceptQueryEmbeddingResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      queryEmbedding: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
    };

    registerEmbeddingHostIpcHandlers(manager as never);

    const statusListener = listeners.get(EMBEDDING_HOST_REPORT_STATUS_CHANNEL);
    if (!statusListener) {
      throw new Error('Embedding host status listener not registered.');
    }

    expect(() =>
      statusListener(
        { sender: { id: 17 } },
        {
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:runtime-1',
          runtimeKind: 'chunking-host',
          state: 'running',
        }
      )
    ).toThrow('embedding-host status report must include runtimeKind="embedding-host".');
    expect(manager.acceptStatusReport).not.toHaveBeenCalled();
  });

  it('forwards valid query embedding response reports', () => {
    const manager = {
      acceptQueryEmbeddingResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      queryEmbedding: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
    };

    registerEmbeddingHostIpcHandlers(manager as never);

    const queryResponseListener = listeners.get(
      EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL
    );
    if (!queryResponseListener) {
      throw new Error('Embedding host query embedding response listener not registered.');
    }

    queryResponseListener(
      { sender: { id: 17 } },
      {
        channel: 'query-embedding-result',
        payload: { embedding: [0.25, 0.5] },
        requestId: 'embedding-host-query:test',
        runtimeId: 'embedding-host:runtime-1',
        type: 'result',
      }
    );

    expect(manager.acceptQueryEmbeddingResponseReport).toHaveBeenCalledWith(17, {
      channel: 'query-embedding-result',
      payload: { embedding: [0.25, 0.5] },
      requestId: 'embedding-host-query:test',
      runtimeId: 'embedding-host:runtime-1',
      type: 'result',
    });
  });

  it('registers a visible-renderer query embedding invoke handler', async () => {
    const manager = {
      acceptQueryEmbeddingResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      queryEmbedding: vi.fn(async () => [0.125, 0.75]),
      reset: vi.fn(),
      stop: vi.fn(),
    };

    registerEmbeddingHostIpcHandlers(manager as never);

    const queryEmbeddingHandler = handlers.get(EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL);
    if (!queryEmbeddingHandler) {
      throw new Error('Embedding host query embedding invoke handler not registered.');
    }

    await expect(
      queryEmbeddingHandler(
        { sender: { id: 17 } },
        {
          dimensions: 384,
          modelId: 'embedding-model',
          modelKey: 'local::Xenova/all-MiniLM-L6-v2',
          query: 'workspace index benchmark',
        }
      )
    ).resolves.toEqual([0.125, 0.75]);
    expect(manager.queryEmbedding).toHaveBeenCalledWith({
      dimensions: 384,
      modelId: 'embedding-model',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'workspace index benchmark',
    });
  });

  it('unregisters lifecycle channels on cleanup', () => {
    const manager = {
      acceptQueryEmbeddingResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      queryEmbedding: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
    };

    const unregister = registerEmbeddingHostIpcHandlers(manager as never);
    unregister();

    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_STOP_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_RESET_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_GET_STATUS_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL);
    expect(removeListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
      listeners.get(EMBEDDING_HOST_REPORT_STATUS_CHANNEL)
    );
    expect(removeListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
      listeners.get(EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL)
    );
  });
  it('validates downloads and routes progress only to the requesting renderer', async () => {
    const downloadModel = vi.fn(
      async (_payload: unknown, options: { onProgress: (progress: number) => void }) => {
        options.onProgress(42);
      }
    );
    registerEmbeddingHostIpcHandlers({ downloadModel } as never);
    const handler = handlers.get(EMBEDDING_HOST_DOWNLOAD_MODEL_CHANNEL);
    if (!handler) {
      throw new Error('Download handler was not registered');
    }
    const send = vi.fn();
    const payload = { cacheDir: '/models', modelId: 'model-a', requestId: 'download-a' };
    await handler({ sender: { id: 7, send } }, payload);
    expect(downloadModel).toHaveBeenCalledWith(payload, { onProgress: expect.any(Function) });
    expect(send).toHaveBeenCalledWith(EMBEDDING_HOST_DOWNLOAD_PROGRESS_EVENT, {
      progress: 42,
      requestId: 'download-a',
    });
    await expect(handler({ sender: { id: 7, send } }, { ...payload, modelId: '' })).rejects.toThrow(
      'modelId'
    );
    expect(downloadModel).toHaveBeenCalledOnce();
  });
});
