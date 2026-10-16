import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL } from '../desktop-platform-diagnostics';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';

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

const role = vi.hoisted(() => vi.fn(() => 'visible-ui'));
const diagnosticReader = vi.hoisted(() => ({
  countByFingerprint: vi.fn(async () => ({ count: 0, firstSeenMs: null, lastSeenMs: null })),
  getUnseenCounts: vi.fn(async () => ({ errorCount: 2, warningCount: 1 })),
  queryEvents: vi.fn(async () => []),
}));
vi.mock('../window-role', () => ({ getWindowRoleByWebContentsId: role }));
vi.mock('../assistant-server/query-diagnostics-tool', () => ({
  mainDiagnosticEventsReader: diagnosticReader,
}));

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
      indexing: null,
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
        indexing: { legacyDatabaseMaintenance: 'not-applicable' },
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

it('validates retained diagnostic filters before I/O and restricts the reader to the visible UI', async () => {
  const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
  const unregister = registerDesktopDiagnosticsIpcHandlers(
    {} as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]
  );
  const query = handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.queryEvents)!;
  const count = handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint)!;
  const event = { sender: { id: 42 }, senderFrame: createAllowlistedSenderFrame() };
  diagnosticReader.queryEvents.mockClear();
  diagnosticReader.countByFingerprint.mockClear();
  for (const invalid of [
    { limit: 201 },
    { limit: 0 },
    { sinceMs: Number.NaN },
    { sinceMs: 20, untilMs: 10 },
    { severity: 'debug' },
    { sql: 'SELECT secret' },
  ]) {
    await expect(query(event, invalid)).rejects.toThrow();
  }
  await expect(count(event, { fingerprint: '', sinceMs: 0 })).rejects.toThrow();
  expect(diagnosticReader.queryEvents).not.toHaveBeenCalled();
  expect(diagnosticReader.countByFingerprint).not.toHaveBeenCalled();
  await expect(query(event, { limit: 100, runId: 'run-1' })).resolves.toEqual([]);
  expect(diagnosticReader.queryEvents).toHaveBeenCalledWith({ limit: 100, runId: 'run-1' });
  await count(event, { fingerprint: 'fp-provider', sinceMs: 0 });
  expect(diagnosticReader.countByFingerprint).toHaveBeenCalledWith('fp-provider', 0);
  role.mockReturnValue('embedding-host');
  await expect(query(event, {})).rejects.toThrow('visible-ui');
  role.mockReturnValue('visible-ui');
  await expect(
    query({ ...event, senderFrame: { url: 'https://foreign.example/' } }, {})
  ).rejects.toThrow();
  unregister();
});

it('validates the unseen watermark before retained reads and keeps the visible role fence', async () => {
  const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
  const unregister = registerDesktopDiagnosticsIpcHandlers(
    {} as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]
  );
  const read = handlers.get(DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts)!;
  const event = { sender: { id: 42 }, senderFrame: createAllowlistedSenderFrame() };
  diagnosticReader.getUnseenCounts.mockClear();
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1000', {}, null]) {
    await expect(read(event, invalid)).rejects.toThrow();
  }
  expect(diagnosticReader.getUnseenCounts).not.toHaveBeenCalled();
  await expect(read(event, 1000)).resolves.toEqual({ errorCount: 2, warningCount: 1 });
  expect(diagnosticReader.getUnseenCounts).toHaveBeenCalledWith(1000);
  role.mockReturnValue('embedding-host');
  await expect(read(event, 0)).rejects.toThrow('visible-ui');
  role.mockReturnValue('visible-ui');
  unregister();
});
