import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL } from '../desktop-platform-diagnostics';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from './helpers/desktop-ipc-sender-test-helpers';

const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));

const isAppWindowSender = vi.hoisted(() => vi.fn(() => true));
const diagnosticReader = vi.hoisted(() => ({
  countByFingerprint: vi.fn(async () => ({ count: 0, firstSeenMs: null, lastSeenMs: null })),
  getUnseenCounts: vi.fn(async () => ({ errorCount: 2, warningCount: 1 })),
  queryEvents: vi.fn(async () => []),
}));
vi.mock('../app-windows', () => ({ isAppWindowSender }));
vi.mock('../assistant-server/query-diagnostics-tool', () => ({
  mainDiagnosticEventsReader: diagnosticReader,
}));

vi.mock('electron', () => ({ ipcMain }));

const appWindowEvent = { sender: { id: 42 }, senderFrame: createAllowlistedSenderFrame() };

function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  return invokeDesktopIpcFrom(ipcMain, appWindowEvent, method, ...args);
}

describe('desktop diagnostics IPC', () => {
  it('serves a typed diagnostics snapshot through the desktop IPC connection', async () => {
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
    } as unknown as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]);

    await expect(invoke(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL)).resolves.toMatchObject({
      ok: true,
      value: {
        database: { hasDatabaseHandle: true },
        databaseIntegrity: { revision: 0, state: { kind: 'healthy' } },
        reset: { userDataPath: '<redacted>' },
        telemetry: {
          processCounters: { installedAt: '2026-09-15T02:00:00.000Z', samples: [] },
        },
      },
    });
    await expect(invoke(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters)).resolves.toEqual({
      ok: true,
      value: { installedAt: '2026-09-15T02:00:00.000Z', samples: [] },
    });

    unregister();

    for (const method of [
      DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
      DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow,
      DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters,
    ]) {
      await expect(invoke(method)).rejects.toThrow(`No desktop IPC handler for ${method}.`);
    }
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
      const response = await invoke(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters);
      expect(response).toMatchObject({
        error: { category: 'internal', code: 'boundary.internal', kind: 'fault' },
        ok: false,
      });
      expect(JSON.stringify(response)).not.toContain('/private/diagnostics');
    } finally {
      unregister();
    }
  });

  it('lists the profile crash dumps and returns a read failure as typed data', async () => {
    const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
    const listing = { directory: '/profile/Crashpad', dumps: [], totalCount: 0 };
    const list = vi
      .fn()
      .mockResolvedValueOnce(listing)
      .mockRejectedValueOnce(new Error('EACCES: /private/profile/Crashpad'));
    const unregister = registerDesktopDiagnosticsIpcHandlers({
      crashDumps: { list },
    } as unknown as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]);
    const method = DESKTOP_IPC_CHANNELS.diagnostics.listCrashDumps;
    try {
      await expect(invoke(method)).resolves.toEqual({ ok: true, value: listing });
      const failed = await invoke(method);
      expect(failed).toMatchObject({ error: { kind: 'fault' }, ok: false });
      expect(JSON.stringify(failed)).not.toContain('/private/profile');
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
    const method = DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow;

    await expect(invoke(method, { since: 'nope', until: 'nope' })).resolves.toMatchObject({
      error: { code: 'boundary.internal' },
      ok: false,
    });
    await expect(
      invoke(method, { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T01:00:00.000Z' })
    ).resolves.toMatchObject({ error: { code: 'boundary.internal' }, ok: false });
    expect(readWindow).not.toHaveBeenCalled();

    const request = { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T02:30:00.000Z' };
    await expect(invoke(method, request)).resolves.toEqual({ ok: true, value: { lines: [] } });
    expect(readWindow).toHaveBeenCalledWith(request);

    unregister();
  });
});

it('validates retained diagnostic filters before I/O and refuses a non-window sender', async () => {
  const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
  const unregister = registerDesktopDiagnosticsIpcHandlers(
    {} as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]
  );
  const query = DESKTOP_IPC_CHANNELS.diagnostics.queryEvents;
  const count = DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint;
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
    await expect(invoke(query, invalid)).rejects.toThrow();
  }
  await expect(invoke(count, { fingerprint: '', sinceMs: 0 })).rejects.toThrow();
  expect(diagnosticReader.queryEvents).not.toHaveBeenCalled();
  expect(diagnosticReader.countByFingerprint).not.toHaveBeenCalled();
  await expect(invoke(query, { limit: 100, runId: 'run-1' })).resolves.toEqual([]);
  expect(diagnosticReader.queryEvents).toHaveBeenCalledWith({ limit: 100, runId: 'run-1' });
  await invoke(count, { fingerprint: 'fp-provider', sinceMs: 0 });
  expect(diagnosticReader.countByFingerprint).toHaveBeenCalledWith('fp-provider', 0);
  isAppWindowSender.mockReturnValue(false);
  await expect(invoke(query, {})).rejects.toThrow('requires an app window sender');
  isAppWindowSender.mockReturnValue(true);
  await expect(
    invokeDesktopIpcFrom(
      ipcMain,
      { ...appWindowEvent, senderFrame: { url: 'https://foreign.example/' } },
      query,
      {}
    )
  ).rejects.toThrow('rejected an unrecognized sender frame URL');
  expect(diagnosticReader.queryEvents).toHaveBeenCalledOnce();
  unregister();
});

it('validates the unseen watermark before retained reads and refuses a non-window sender', async () => {
  const { registerDesktopDiagnosticsIpcHandlers } = await import('../ipc-desktop-diagnostics');
  const unregister = registerDesktopDiagnosticsIpcHandlers(
    {} as Parameters<typeof registerDesktopDiagnosticsIpcHandlers>[0]
  );
  const read = DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts;
  diagnosticReader.getUnseenCounts.mockClear();
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1000', {}, null]) {
    await expect(invoke(read, invalid)).rejects.toThrow();
  }
  expect(diagnosticReader.getUnseenCounts).not.toHaveBeenCalled();
  await expect(invoke(read, 1000)).resolves.toEqual({ errorCount: 2, warningCount: 1 });
  expect(diagnosticReader.getUnseenCounts).toHaveBeenCalledWith(1000);
  isAppWindowSender.mockReturnValue(false);
  await expect(invoke(read, 0)).rejects.toThrow('requires an app window sender');
  isAppWindowSender.mockReturnValue(true);
  expect(diagnosticReader.getUnseenCounts).toHaveBeenCalledOnce();
  unregister();
});
