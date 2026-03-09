import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, listeners } = vi.hoisted(() => {
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
  };
});

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
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
    }),
  };
});

import {
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
});
