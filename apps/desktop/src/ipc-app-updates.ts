import { ipcMain } from 'electron';
import type { AppUpdatePreferences } from './ipc-domains/app-updates.contract';
import { appUpdatesContract } from './ipc-domains/app-updates.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export interface AppUpdatesHandlers {
  readonly getPreferences: () => AppUpdatePreferences;
  readonly setBetaUpdates: (enabled: boolean) => AppUpdatePreferences;
}

/** Registers the Settings › Updates channels (BST-2367). */
export function registerAppUpdatesIpcHandlers(handlers: AppUpdatesHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'appUpdates', appUpdatesContract, {
    getPreferences: () =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.read-failed' }, () =>
        handlers.getPreferences()
      ),
    setBetaUpdates: (enabled) =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.write-failed' }, () =>
        handlers.setBetaUpdates(enabled)
      ),
  });
  return () => {
    registry.unregisterAll();
  };
}
