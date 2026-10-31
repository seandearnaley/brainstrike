import { ipcMain } from 'electron';
import { mainDiagnosticEventsReader } from './assistant-server/query-diagnostics-tool';
import {
  collectDesktopPlatformDiagnostics,
  DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
  type DesktopPlatformDiagnosticsProviders,
} from './desktop-platform-diagnostics';
import { assertMainLogWindowRequest } from './diagnostics/main-log-window';
import {
  assertRetainedEventsQuery,
  assertRetainedFingerprintCount,
  assertUnseenDiagnosticsWatermark,
} from './diagnostics/retained-events-request';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';

export function registerDesktopDiagnosticsIpcHandlers(
  providers: DesktopPlatformDiagnosticsProviders
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.handle('diagnostics', DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.snapshot-failed' }, () =>
      collectDesktopPlatformDiagnostics(providers)
    )
  );

  // The window is validated BEFORE the provider is touched: a malformed or
  // oversized request rejects here and never opens a log file.
  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow,
    (_event, request: unknown) =>
      settleIpcResult({ category: 'diagnostics', code: 'diagnostics.log-read-failed' }, () =>
        providers.mainLog.readWindow(assertMainLogWindowRequest(request, Date.now()))
      )
  );

  registry.handle('diagnostics', DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.counters-failed' }, () =>
      providers.processCounters.getSnapshot()
    )
  );

  registry.handle('diagnostics', DESKTOP_IPC_CHANNELS.diagnostics.listCrashDumps, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.crash-dumps-failed' }, () =>
      providers.crashDumps.list()
    )
  );

  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.queryEvents,
    async (_event, request: unknown) =>
      mainDiagnosticEventsReader.queryEvents(assertRetainedEventsQuery(request))
  );
  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint,
    async (_event, request: unknown) => {
      const { fingerprint, sinceMs } = assertRetainedFingerprintCount(request);
      return mainDiagnosticEventsReader.countByFingerprint(fingerprint, sinceMs);
    }
  );

  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts,
    async (_event, sinceMs: unknown) =>
      mainDiagnosticEventsReader.getUnseenCounts(assertUnseenDiagnosticsWatermark(sinceMs))
  );

  return () => registry.unregisterAll();
}
