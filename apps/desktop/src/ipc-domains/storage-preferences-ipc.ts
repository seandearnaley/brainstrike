import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import {
  assertRendererWritableDesktopStorageKey,
  isMainOwnedDesktopStorageKey,
  MAIN_OWNED_DESKTOP_STORAGE_KEYS,
} from '../platform/desktop-storage-authority';
import type { DesktopSettingsStoreSchema } from '../store-schema';
import { settingsContract, storageContract } from './storage-preferences.contract';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly storage: ElectronStorageAdapter;
}

type DesktopSettingsStoreAccess = ElectronStore<DesktopSettingsStoreSchema> & {
  readonly clear: () => void;
};

function getSettingsStoreAccess(
  getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null
): DesktopSettingsStoreAccess | null {
  const store = getStore();
  return store as DesktopSettingsStoreAccess | null;
}

export function registerStoragePreferencesIpcHandlers({
  getStore,
  storage,
}: RegisterStoragePreferencesIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registerDomain(registry, 'storage', storageContract, {
    clear: async () => {
      // Renderer factory-reset cleanup may clear preference slices, but only
      // desktop main's reset barrier may erase root authority ledgers.
      await storage.clearExcept(MAIN_OWNED_DESKTOP_STORAGE_KEYS);
    },
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

  registerDomain(registry, 'preferences', settingsContract, {
    clearAll: async () => {
      try {
        const store = getSettingsStoreAccess(getStore);
        if (!store) {
          return { message: 'Store not initialized', success: false };
        }
        store.clear();
        return { success: true };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          success: false,
        };
      }
    },
  });

  return () => registry.unregisterAll();
}
