import type { ContentClearResult } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { getFactoryResetUnavailableReason } from './factory-reset-availability';
import { contentClearContract } from './ipc-domains/content-clear.contract';
import { databasePathContract } from './ipc-domains/database.contract';
import { factoryResetContract } from './ipc-domains/factory-reset.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

export function registerFactoryResetIpcHandlers(
  resetLocal: () => Promise<{ success: boolean; message?: string }>
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'runtime', factoryResetContract, {
    resetLocal: () => {
      const unavailableReason = getFactoryResetUnavailableReason(process.platform);
      return unavailableReason ? { message: unavailableReason, success: false } : resetLocal();
    },
  });
  return () => registry.unregisterAll();
}

export function registerProfilePathIpcHandlers(getUserDataPath: () => string): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'runtime', databasePathContract, { getUserDataPath });
  return () => registry.unregisterAll();
}

export function registerContentClearIpcHandlers(
  clear: () => Promise<ContentClearResult>
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'runtime', contentClearContract, { clear });
  return () => registry.unregisterAll();
}
