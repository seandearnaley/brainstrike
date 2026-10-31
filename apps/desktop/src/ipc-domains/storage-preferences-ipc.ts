import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { ipcMain } from 'electron';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import {
  assertRendererWritableDesktopStorageKey,
  isMainOwnedDesktopStorageKey,
} from '../platform/desktop-storage-authority';
import { storageContract } from './storage-preferences.contract';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly storage: ElectronStorageAdapter;
}

export function registerStoragePreferencesIpcHandlers({
  storage,
}: RegisterStoragePreferencesIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registerDomain(registry, 'storage', storageContract, {
    getAllKeys: () => storage.getAllKeys(),
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => {
      assertRendererWritableDesktopStorageKey(key);
      return storage.removeItem(key);
    },
    setItem: (key, value) => {
      assertRendererWritableDesktopStorageKey(key);
      return storage.setItem(key, value);
    },
  });

  if (isElectronE2ETestMode()) {
    // These channels deliberately remain a conditional adapter instead of a
    // discoverable contract: production must not register them, while the
    // global contract manifest requires every exported invoke unconditionally.
    registry.handle(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
      async (_event, key: unknown, value: unknown) => {
        if (!isMainOwnedDesktopStorageKey(key)) {
          throw new Error('E2E main-owned storage seed requires a main-owned key.');
        }
        if (typeof value !== 'string') {
          throw new TypeError('E2E main-owned storage seed value must be a string.');
        }
        return storage.setItem(key, value);
      }
    );
    registry.handle('storage', DESKTOP_IPC_CHANNELS.storage.clearAllForE2e, async () =>
      storage.clear()
    );
  }

  return () => registry.unregisterAll();
}
