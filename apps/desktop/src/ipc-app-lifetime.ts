import { Schema } from 'effect';
import { ipcMain } from 'electron';
import type { AppLifetime } from './app-lifetime';
import { appLifetimeContract } from './ipc-domains/app-lifetime.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
import { NoArgs } from './platform/ipc-args';

/** Registers the Settings › Startup channels (ADR-0033). */
export function registerAppLifetimeIpcHandlers(
  lifetime: Pick<AppLifetime, 'setKeepRunningInTray' | 'setOpenAtLogin' | 'settings'>
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'appLifetime',
    appLifetimeContract,
    {
      getSettings: NoArgs,
      setKeepRunningInTray: Schema.Tuple([Schema.Boolean]),
      setOpenAtLogin: Schema.Tuple([Schema.Boolean]),
    },
    {
      getSettings: () =>
        settleIpcResult({ category: 'appLifetime', code: 'app-lifetime.read-failed' }, () =>
          lifetime.settings()
        ),
      setKeepRunningInTray: (enabled) =>
        settleIpcResult({ category: 'appLifetime', code: 'app-lifetime.write-failed' }, () =>
          lifetime.setKeepRunningInTray(enabled)
        ),
      setOpenAtLogin: (enabled) =>
        settleIpcResult({ category: 'appLifetime', code: 'app-lifetime.write-failed' }, () =>
          lifetime.setOpenAtLogin(enabled)
        ),
    }
  );
  return () => {
    registry.unregisterAll();
  };
}
