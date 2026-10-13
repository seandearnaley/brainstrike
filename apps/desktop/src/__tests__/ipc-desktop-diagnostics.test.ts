import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL } from '../desktop-platform-diagnostics';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

const { handlers, ipcMainHandle, ipcMainRemoveHandler } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMainHandle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
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
      databaseIntegrity: {
        getSnapshot: vi.fn(() => ({ revision: 0, state: { kind: 'healthy' } })),
      },
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
        getTelemetrySnapshot: vi.fn(() => ({
          batchTransfer: { batchCount: 0, lastBytes: 0, peakBytes: 0, totalBytes: 0 },
          cache: {
            entries: [],
            estimatedGpuBytes: 0,
            estimatedHeapBytes: 0,
            memoryEstimateUnavailableCount: 0,
            residentCount: 0,
          },
          lastUpdatedAt: null,
          peakVectorsInFlight: 0,
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
      processCounters: {
        getSnapshot: vi.fn(() => ({ installedAt: '2026-09-15T02:00:00.000Z', samples: [] })),
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
    } as unknown as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]);

    const handler = handlers.get(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
    expect(handler).toBeDefined();
    await expect(handler?.()).resolves.toMatchObject({
      ok: true,
      value: {
        database: { hasDatabaseHandle: true },
        databaseIntegrity: { revision: 0, state: { kind: 'healthy' } },
        indexing: { activeBackfills: [] },
        reset: { userDataPath: '<redacted>' },
        telemetry: {
          backgroundRuntimeMetrics: [],
          embedding: { batchTransfer: { totalBytes: 0 }, peakVectorsInFlight: 0 },
          processCounters: { installedAt: '2026-09-15T02:00:00.000Z', samples: [] },
        },
      },
    });
    const countersHandler = handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters);
    expect(countersHandler).toBeDefined();
    await expect(countersHandler?.()).resolves.toEqual({
      ok: true,
      value: { installedAt: '2026-09-15T02:00:00.000Z', samples: [] },
    });

    unregister();

    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow
    );
    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters
    );
  });

  it('returns private diagnostic reader faults as typed data', async () => {
    const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
    const unregister = registerDesktopDiagnosticsIpcHandlers({
      processCounters: {
        getSnapshot: () => {
          throw new Error('/private/diagnostics/reader');
        },
      },
    } as unknown as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]);
    try {
      const response = await handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters)?.();
      expect(response).toMatchObject({
        error: { category: 'internal', code: 'boundary.internal', kind: 'fault' },
        ok: false,
      });
      expect(JSON.stringify(response)).not.toContain('/private/diagnostics');
    } finally {
      unregister();
    }
  });

  it('validates the main-log window before touching the provider and forwards a valid one', async () => {
    const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
    const readWindow = vi.fn().mockResolvedValue({ lines: [] });
    const unregister = registerDesktopDiagnosticsIpcHandlers({
      mainLog: { readWindow },
    } as unknown as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]);
    const handler = handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow);
    expect(handler).toBeDefined();

    await expect(handler?.({}, { since: 'nope', until: 'nope' })).resolves.toMatchObject({
      error: { code: 'boundary.internal' },
      ok: false,
    });
    await expect(
      handler?.({}, { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T01:00:00.000Z' })
    ).resolves.toMatchObject({ error: { code: 'boundary.internal' }, ok: false });
    expect(readWindow).not.toHaveBeenCalled();

    const request = { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T02:30:00.000Z' };
    await expect(handler?.({}, request)).resolves.toEqual({ ok: true, value: { lines: [] } });
    expect(readWindow).toHaveBeenCalledWith(request);

    unregister();
  });
});
