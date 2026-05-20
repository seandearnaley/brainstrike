import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL } from '../desktop-platform-diagnostics';

const { handlers, ipcMainHandle, ipcMainRemoveHandler } = vi.hoisted(() => {
  const handlers = new Map<string, () => unknown>();
  return {
    handlers,
    ipcMainHandle: vi.fn((channel: string, handler: () => unknown) => {
      handlers.set(channel, handler);
    }),
    ipcMainRemoveHandler: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMainHandle,
    on: vi.fn(),
    removeHandler: ipcMainRemoveHandler,
    removeListener: vi.fn(),
  },
}));

describe('desktop diagnostics IPC', () => {
  it('registers a typed diagnostics snapshot channel through the desktop IPC registry', async () => {
    const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
    const unregister = registerDesktopDiagnosticsIpcHandlers({
      database: { getDiagnostics: vi.fn(async () => ({ hasDatabaseHandle: true })) },
      databaseScheduler: { getSnapshot: vi.fn(() => ({ activeCount: 0 })) },
      embeddingHost: {
        getPlatformStatus: vi.fn(() => ({
          active: false,
          lastError: null,
          pendingRequestCount: 0,
          runtimeId: 'embedding-host:stopped',
          runtimeKind: 'embedding-host',
          sourceState: 'stopped',
          state: 'stopped',
        })),
      },
      llmHost: {
        getPlatformStatus: vi.fn(() => ({
          active: false,
          lastError: null,
          pendingRequestCount: 0,
          runtimeId: 'llm-host:stopped',
          runtimeKind: 'llm-host',
          sourceState: 'stopped',
          state: 'stopped',
        })),
      },
      logging: {
        getState: vi.fn(() => ({
          capabilities: { fileDestination: false },
          preferences: {
            console: true,
            file: { enabled: false, path: null },
            level: 'info',
            redactPaths: [],
          },
        })),
      },
      reset: { getUserDataPath: vi.fn(() => '/tmp/user-data') },
    });

    const handler = handlers.get(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
    expect(handler).toBeDefined();
    await expect(handler?.()).resolves.toMatchObject({
      database: { hasDatabaseHandle: true },
      reset: { userDataPath: '/tmp/user-data' },
    });

    unregister();

    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
  });
});
