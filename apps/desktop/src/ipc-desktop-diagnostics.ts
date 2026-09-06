import { ipcMain } from 'electron';
import {
  collectDesktopPlatformDiagnostics,
  DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
  type DesktopPlatformDiagnosticsProviders,
  type DesktopPlatformDiagnosticsSnapshot,
} from './desktop-platform-diagnostics';
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

  return () => registry.unregisterAll();
}
