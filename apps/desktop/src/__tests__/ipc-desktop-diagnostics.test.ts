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
      crashRecovery: {
        getSnapshot: vi.fn(() => ({
          lastRendererCrashAt: null,
          lastRendererCrashReason: null,
          lastRendererReloadAt: null,
          pendingRendererRecovery: false,
          rendererCrashCount: 0,
          rendererReloadAttemptCount: 0,
          suppressedRendererReloadCount: 0,
        })),
      },
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
      indexing: { getBackfillsInFlight: vi.fn(() => []) },
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
      reset: {
        getSnapshot: vi.fn(() => ({
          lastCompletedAt: null,
          lastDeletedPathCount: 0,
          lastError: null,
          lastFailedAt: null,
          lastPreservedPathCount: 0,
          status: 'idle',
          userDataPath: '/tmp/user-data',
        })),
      },
      telemetry: { getRuntimeMetrics: vi.fn(() => []) },
    });

    const handler = handlers.get(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
    expect(handler).toBeDefined();
    await expect(handler?.()).resolves.toMatchObject({
      database: { hasDatabaseHandle: true },
      indexing: { activeBackfills: [] },
      reset: { userDataPath: '<redacted>' },
      telemetry: { backgroundRuntimeMetrics: [] },
    });

    unregister();

    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
  });
});
