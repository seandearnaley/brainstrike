import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { mainDiagnosticEventsReader } from './assistant-server/query-diagnostics-tool';
import {
  collectDesktopPlatformDiagnostics,
  DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
  type DesktopPlatformDiagnosticsProviders,
} from './desktop-platform-diagnostics';
import { assertMainLogWindowRequest } from './diagnostics/main-log-window';
import { retainedEventsArgs, toRetainedEventsFilter } from './diagnostics/retained-events-request';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';
import { NoArgs } from './platform/ipc-args';

export function registerDesktopDiagnosticsIpcHandlers(
  providers: DesktopPlatformDiagnosticsProviders
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.handle('diagnostics', DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL, NoArgs, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.snapshot-failed' }, () =>
      collectDesktopPlatformDiagnostics(providers)
    )
  );

  // The window is validated BEFORE the provider is touched: a malformed or
  // oversized request rejects here and never opens a log file.
  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow,
    Schema.Tuple([Schema.Struct({ since: Schema.String, until: Schema.String })]),
    (_event, request) =>
      settleIpcResult({ category: 'diagnostics', code: 'diagnostics.log-read-failed' }, () =>
        providers.mainLog.readWindow(assertMainLogWindowRequest(request, Date.now()))
      )
  );

  registry.handle('diagnostics', DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters, NoArgs, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.counters-failed' }, () =>
      providers.processCounters.getSnapshot()
    )
  );

  registry.handle('diagnostics', DESKTOP_IPC_CHANNELS.diagnostics.listCrashDumps, NoArgs, () =>
    settleIpcResult({ category: 'diagnostics', code: 'diagnostics.crash-dumps-failed' }, () =>
      providers.crashDumps.list()
    )
  );

  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.queryEvents,
    retainedEventsArgs.queryEvents,
    async (_event, request) =>
      mainDiagnosticEventsReader.queryEvents(toRetainedEventsFilter(request))
  );
  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint,
    retainedEventsArgs.countByFingerprint,
    async (_event, { fingerprint, sinceMs }) =>
      mainDiagnosticEventsReader.countByFingerprint(fingerprint, sinceMs)
  );

  registry.handle(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts,
    retainedEventsArgs.getUnseenCounts,
    async (_event, sinceMs) => mainDiagnosticEventsReader.getUnseenCounts(sinceMs)
  );

  return () => registry.unregisterAll();
}
