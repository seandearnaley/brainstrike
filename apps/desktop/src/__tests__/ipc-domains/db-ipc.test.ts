import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { handlers, removeHandler } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, IpcHandler>();
  return {
    handlers: registeredHandlers,
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import { registerDatabaseIpcHandlers } from '../../ipc-domains/db-ipc';

describe('database IPC domain', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    registerDatabaseIpcHandlers({});
  });

  it('registers lightweight diagnostics handlers and unregisters owned channels', async () => {
    await expect(handlers.get('db:ping')?.({} as IpcMainInvokeEvent)).resolves.toEqual({
      message: 'ping',
      success: true,
    });
    await expect(
      handlers.get('db:scheduler:snapshot')?.({} as IpcMainInvokeEvent)
    ).resolves.toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      runningPriority: null,
    });

    const unregister = registerDatabaseIpcHandlers({});
    unregister();
    expect(removeHandler).toHaveBeenCalledWith('db:ping');
    expect(removeHandler).toHaveBeenCalledWith('db:scheduler:snapshot');
    expect(removeHandler).toHaveBeenCalledWith('db:live-query:start');
  });

  it('rejects malformed renderer SQL before scheduling database work', async () => {
    await expect(
      handlers.get('db:query')?.({} as IpcMainInvokeEvent, 'SELECT\0 1')
    ).rejects.toThrow('db:query SQL must not contain null bytes.');

    await expect(handlers.get('db:exec')?.({} as IpcMainInvokeEvent, '')).rejects.toThrow(
      'db:exec SQL must be a non-empty string.'
    );
  });

  it('keeps raw renderer SQL inside the documented app-internal policy', async () => {
    await expect(
      handlers.get('db:query')?.({} as IpcMainInvokeEvent, 'DROP TABLE file_records')
    ).rejects.toThrow('db:query does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.({} as IpcMainInvokeEvent, 'DROP TABLE file_records')
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');
  });
});
