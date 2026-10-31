import { ipcMain } from 'electron';
import type { AppUpdatePreferences, AppUpdateStatus } from './ipc-domains/app-updates.contract';
import { appUpdatesContract } from './ipc-domains/app-updates.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export interface AppUpdatesHandlers {
  readonly checkNow: () => Promise<AppUpdateStatus>;
  readonly getPreferences: () => AppUpdatePreferences;
  readonly getStatus: () => AppUpdateStatus;
  readonly restartToUpdate: () => void;
  readonly setBetaUpdates: (enabled: boolean) => AppUpdatePreferences;
}

/** Registers the Settings › Updates channels (BST-2367, BST-2356). */
export function registerAppUpdatesIpcHandlers(handlers: AppUpdatesHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'appUpdates', appUpdatesContract, {
    checkNow: () =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.check-failed' }, () =>
        handlers.checkNow()
      ),
    getPreferences: () =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.read-failed' }, () =>
        handlers.getPreferences()
      ),
    getStatus: () =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.read-failed' }, () =>
        handlers.getStatus()
      ),
    restartToUpdate: () =>
      settleIpcResult({ category: 'appUpdates', code: 'app-updates.restart-failed' }, () =>
        handlers.restartToUpdate()
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
