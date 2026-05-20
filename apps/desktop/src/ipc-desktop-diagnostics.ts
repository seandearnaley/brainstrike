import { ipcMain } from 'electron';
import {
  collectDesktopPlatformDiagnostics,
  DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
  type DesktopPlatformDiagnosticsProviders,
  type DesktopPlatformDiagnosticsSnapshot,
} from './desktop-platform-diagnostics';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerDesktopDiagnosticsIpcHandlers(
  providers: DesktopPlatformDiagnosticsProviders
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'diagnostics',
    DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL,
    async (): Promise<DesktopPlatformDiagnosticsSnapshot> =>
      collectDesktopPlatformDiagnostics(providers)
  );

  return () => registry.unregisterAll();
}
