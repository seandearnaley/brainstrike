import { ipcMain } from 'electron';
import {
  collectDesktopPlatformDiagnostics,
  DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
  type DesktopPlatformDiagnosticsProviders,
  type DesktopPlatformDiagnosticsSnapshot,
} from './desktop-platform-diagnostics';
import {
  assertMainLogWindowRequest,
  type MainLogWindowResult,
} from './diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from './diagnostics/process-counter-ring';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

export function registerDesktopDiagnosticsIpcHandlers(
  providers: DesktopPlatformDiagnosticsProviders
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'diagnostics',
    DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (): Promise<DesktopPlatformDiagnosticsSnapshot> =>
      collectDesktopPlatformDiagnostics(providers)
  );

  // The window is validated BEFORE the provider is touched: a malformed or
  // oversized request rejects here and never opens a log file.
  registry.registerUnauthenticatedInvoke(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, request: unknown): Promise<MainLogWindowResult> =>
      await providers.mainLog.readWindow(assertMainLogWindowRequest(request, Date.now()))
  );

  registry.registerUnauthenticatedInvoke(
    'diagnostics',
    DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters,
    UNAUTHENTICATED_SENDER_POLICY,
    (): ProcessCounterSnapshot => providers.processCounters.getSnapshot()
  );

  return () => registry.unregisterAll();
}
