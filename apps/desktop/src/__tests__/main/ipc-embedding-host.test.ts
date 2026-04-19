import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, listeners, removeListener, removeHandler } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  removeListener: vi.fn(),
  removeHandler: vi.fn(),
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
      removeListener,
      removeHandler,
    }),
  };
});

import {
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
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
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn().mockResolvedValue({ state: 'running' }),
      getStatus: vi.fn().mockResolvedValue({ state: 'running' }),
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
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:runtime-1',
        state: 'running',
        active: true,
        lastError: null,
      }
    );

    expect(manager.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
    expect(manager.getStatus).toHaveBeenCalledTimes(1);
    expect(manager.reset).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.acceptStatusReport).toHaveBeenCalledWith(17, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:runtime-1',
      state: 'running',
      active: true,
      lastError: null,
    });
  });

  it('fails fast on malformed embedding status reports', () => {
    const manager = {
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
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
          runtimeKind: 'chunking-host',
          runtimeId: 'embedding-host:runtime-1',
          state: 'running',
          active: true,
          lastError: null,
        }
      )
    ).toThrow('embedding-host status report must include runtimeKind="embedding-host".');
    expect(manager.acceptStatusReport).not.toHaveBeenCalled();
  });

  it('unregisters lifecycle channels on cleanup', () => {
    const manager = {
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
    };

    const unregister = registerEmbeddingHostIpcHandlers(manager as never);
    unregister();

    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_STOP_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_RESET_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_GET_STATUS_CHANNEL);
    expect(removeListener).toHaveBeenCalledWith(
      EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
      listeners.get(EMBEDDING_HOST_REPORT_STATUS_CHANNEL)
    );
  });
});
