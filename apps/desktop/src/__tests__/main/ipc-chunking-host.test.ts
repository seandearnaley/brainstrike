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
  CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
  CHUNKING_HOST_CHUNK_FILE_CHANNEL,
  CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
  CHUNKING_HOST_REPORT_STATUS_CHANNEL,
} from '../../chunking-host-shared';
import { registerChunkingHostIpcHandlers } from '../../ipc-chunking-host';

describe('chunking host IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    vi.clearAllMocks();
  });

  it('accepts valid chunking response reports', () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const reportListener = listeners.get(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL);
    if (!reportListener) {
      throw new Error('Chunking host response listener not registered.');
    }

    reportListener(
      { sender: { id: 42 } },
      {
        type: 'progress',
        channel: 'chunk',
        requestId: 'request-1',
        runtimeId: 'chunking-host:runtime-1',
        payload: {
          fileRecordId: 'file-1',
          chunksCreated: 3,
        },
      }
    );

    expect(manager.acceptResponseReport).toHaveBeenCalledWith(42, {
      type: 'progress',
      channel: 'chunk',
      requestId: 'request-1',
      runtimeId: 'chunking-host:runtime-1',
      payload: {
        fileRecordId: 'file-1',
        chunksCreated: 3,
      },
    });
  });

  it('fails fast on malformed chunk-batch response payloads', () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const reportListener = listeners.get(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL);
    if (!reportListener) {
      throw new Error('Chunking host response listener not registered.');
    }

    expect(() =>
      reportListener(
        { sender: { id: 42 } },
        {
          type: 'result',
          channel: 'chunk-batch-complete',
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          payload: {
            results: [
              {
                type: 'result',
                id: 'chunk-1',
                fileRecordId: '',
                chunks: [],
                skipped: false,
                strategyUsed: 'sentence',
                totalTokens: 1,
              },
            ],
          },
        }
      )
    ).toThrow(
      'Chunking host batch-complete payload results[0] must include a non-empty fileRecordId.'
    );
    expect(manager.acceptResponseReport).not.toHaveBeenCalled();
  });

  it('fails fast on malformed chunking response reports', () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const reportListener = listeners.get(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL);
    if (!reportListener) {
      throw new Error('Chunking host response listener not registered.');
    }

    expect(() =>
      reportListener(
        { sender: { id: 42 } },
        {
          type: 'bogus',
          channel: 'chunk',
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          payload: {},
        }
      )
    ).toThrow('Chunking host response report must include a valid runtime envelope type.');
    expect(manager.acceptResponseReport).not.toHaveBeenCalled();
  });

  it('wires status and response listeners separately', () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    expect(listeners.has(CHUNKING_HOST_REPORT_STATUS_CHANNEL)).toBe(true);
    expect(listeners.has(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL)).toBe(true);
  });

  it('accepts valid chunk-file requests', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const chunkFileHandler = handlers.get(CHUNKING_HOST_CHUNK_FILE_CHANNEL);
    if (!chunkFileHandler) {
      throw new Error('Chunking host chunk-file handler not registered.');
    }

    await chunkFileHandler(
      { sender: { id: 42 } },
      {
        kind: 'chunk-file',
        requestId: 'request-1',
        fileRecordId: 'file-1',
        fileName: 'demo.ts',
        filePath: '/demo.ts',
        content: 'const demo = true;',
        options: {},
      }
    );

    expect(manager.chunkFile).toHaveBeenCalledWith(42, {
      kind: 'chunk-file',
      requestId: 'request-1',
      fileRecordId: 'file-1',
      fileName: 'demo.ts',
      filePath: '/demo.ts',
      content: 'const demo = true;',
      options: {},
    });
  });

  it('fails fast on malformed chunk-batch requests', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const chunkBatchHandler = handlers.get(CHUNKING_HOST_CHUNK_BATCH_CHANNEL);
    if (!chunkBatchHandler) {
      throw new Error('Chunking host chunk-batch handler not registered.');
    }

    await expect(() =>
      chunkBatchHandler(
        { sender: { id: 42 } },
        {
          kind: 'chunk-file',
          requestId: 'request-1',
          files: [],
          options: {},
        }
      )
    ).rejects.toThrow('Chunking host chunk-batch request must declare kind="chunk-batch".');
    expect(manager.chunkBatch).not.toHaveBeenCalled();
  });

  it('fails fast on invalid numeric chunking options', async () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    registerChunkingHostIpcHandlers(manager as never);

    const chunkFileHandler = handlers.get(CHUNKING_HOST_CHUNK_FILE_CHANNEL);
    if (!chunkFileHandler) {
      throw new Error('Chunking host chunk-file handler not registered.');
    }

    await expect(() =>
      chunkFileHandler(
        { sender: { id: 42 } },
        {
          kind: 'chunk-file',
          requestId: 'request-2',
          fileRecordId: 'file-1',
          fileName: 'demo.ts',
          filePath: '/demo.ts',
          content: 'const demo = true;',
          options: {
            maxTokens: 0,
            overlap: Number.POSITIVE_INFINITY,
          },
        }
      )
    ).rejects.toThrow(
      'Chunking host request options maxTokens must be greater than zero when set.'
    );
    expect(manager.chunkFile).not.toHaveBeenCalled();
  });

  it('removes only the registered response listener on cleanup', () => {
    const manager = {
      acceptResponseReport: vi.fn(),
      acceptStatusReport: vi.fn(),
      ensureStarted: vi.fn(),
      getStatus: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      chunkFile: vi.fn(),
      chunkBatch: vi.fn(),
    };

    const unregister = registerChunkingHostIpcHandlers(manager as never);
    const registeredListener = listeners.get(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL);
    if (!registeredListener) {
      throw new Error('Chunking host response listener not registered.');
    }

    unregister();

    expect(removeHandler).toHaveBeenCalledWith(CHUNKING_HOST_CHUNK_FILE_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(CHUNKING_HOST_CHUNK_BATCH_CHANNEL);
    expect(removeListener).toHaveBeenCalledWith(
      CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
      registeredListener
    );
  });
});
