import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';

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

    registerEmbeddingHostIpcHandlers(manager as never, { stop: () => manager.stop() });

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

    registerEmbeddingHostIpcHandlers(manager as never, { stop: () => manager.stop() });

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

    registerEmbeddingHostIpcHandlers(manager as never, { stop: () => manager.stop() });

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

    const unregister = registerEmbeddingHostIpcHandlers(manager as never, {
      stop: () => manager.stop(),
    });
    const sender = Object.assign(new EventEmitter(), { id: 17 });
    assignWindowRole({ once: vi.fn(), webContents: sender } as never, 'visible-ui');

    const queryEmbeddingHandler = handlers.get(EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL);
    if (!queryEmbeddingHandler) {
      throw new Error('Embedding host query embedding invoke handler not registered.');
    }

    await expect(
      queryEmbeddingHandler(
        { sender, senderFrame: createAllowlistedSenderFrame() },
        {
          payload: {
            dimensions: 384,
            modelId: 'embedding-model',
            modelKey: 'local::Xenova/all-MiniLM-L6-v2',
            query: 'workspace index benchmark',
          },
          requestId: 'query-test',
        }
      )
    ).resolves.toEqual([0.125, 0.75]);
    expect(manager.queryEmbedding).toHaveBeenCalledWith(
      {
        dimensions: 384,
        modelId: 'embedding-model',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'workspace index benchmark',
      },
      { signal: expect.any(AbortSignal) }
    );
    unregister();
    clearWindowRoleByWebContentsId(sender.id);
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

    const unregister = registerEmbeddingHostIpcHandlers(manager as never, {
      stop: () => manager.stop(),
    });
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
});

describe('document IPC cancellation sender ownership', () => {
  it('binds cancellation to one sender and plain token, including startup', async () => {
    handlers.clear();
    listeners.clear();
    const pending = Promise.withResolvers<number[][]>();
    const documentEmbeddings = vi.fn((_payload: unknown, options: { signal: AbortSignal }) => {
      options.signal.addEventListener('abort', () => pending.reject(options.signal.reason), {
        once: true,
      });
      return pending.promise;
    });
    const manager = {
      documentEmbeddings,
      stop: async () => {
        throw new Error('This document-only fixture does not stop the embedding host.');
      },
    };
    const unregister = registerEmbeddingHostIpcHandlers(manager as never, {
      stop: () => manager.stop(),
    });
    const senderA = Object.assign(new EventEmitter(), { id: 301 });
    const senderB = Object.assign(new EventEmitter(), { id: 302 });
    for (const sender of [senderA, senderB]) {
      assignWindowRole({ once: vi.fn(), webContents: sender } as never, 'visible-ui');
    }
    const event = (sender: typeof senderA) => ({
      sender,
      senderFrame: createAllowlistedSenderFrame(),
    });
    const request = handlers.get(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddings);
    const cancel = handlers.get(DESKTOP_IPC_CHANNELS.embeddingHost.cancelDocumentEmbeddings);
    if (!(request && cancel)) {
      throw new Error('Missing document IPC handlers');
    }
    const payload = {
      dimensions: 384,
      inferencePlan: {
        device: 'wasm',
        dimensions: 384,
        dtype: 'q8',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        revision: '751bff37182d3f1213fa05d7196b954e230abad9',
      },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'native:docs',
      texts: ['document'],
    };
    try {
      const result = request(event(senderA), { payload, requestId: 'request-a' });
      const rejected = expect(result).rejects.toThrow('Document embeddings canceled');
      await cancel(event(senderB), 'request-a');
      const signal = documentEmbeddings.mock.calls[0]?.[1].signal;
      expect(signal?.aborted).toBe(false);
      await expect(request(event(senderA), { payload, requestId: 'request-a' })).rejects.toThrow(
        'already in flight'
      );
      await cancel(event(senderA), 'request-a');
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(senderA.listenerCount('destroyed')).toBe(0);
      await expect(
        request(
          { ...event(senderA), senderFrame: { url: 'https://untrusted.invalid' } },
          { payload, requestId: 'request-b' }
        )
      ).rejects.toThrow('unrecognized sender');
      clearWindowRoleByWebContentsId(senderB.id);
      await expect(cancel(event(senderB), 'request-a')).rejects.toThrow('sender role');
    } finally {
      unregister();
      clearWindowRoleByWebContentsId(senderA.id);
      clearWindowRoleByWebContentsId(senderB.id);
    }
  });
});
