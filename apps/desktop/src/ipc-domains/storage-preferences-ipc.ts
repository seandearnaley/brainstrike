import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { createDesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import { VECTOR_PREFERENCES_STORAGE_KEY } from '../platform/vector-preferences-storage-key';
import type { DesktopSettingsStoreSchema } from '../store-schema';
import {
  settingsContract,
  storageContract,
  vectorPreferencesContract,
} from './storage-preferences.contract';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly onStorageChanged?: (key: string) => void;
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
  onStorageChanged,
}: RegisterStoragePreferencesIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registerDomain(registry, 'storage', storageContract, {
    clear: () => storage.clear(),
    getAllKeys: () => storage.getAllKeys(),
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => storage.removeItem(key),
    setItem: async (key, value) => {
      const previous = await storage.getItem(key);
      await storage.setItem(key, value);
      if (previous !== value) {
        onStorageChanged?.(key);
      }
    },
  });

  // BST-1380: hidden inference hosts resolve their device preference from the
  // SAME canonical record the visible UI writes. They receive this scoped
  // capability instead of the unrestricted `storage` bridge above — the key is
  // pinned here, never supplied by the renderer, so a hidden host can neither
  // enumerate keys nor address another persisted store.
  registerDomain(registry, 'vectorPreferences', vectorPreferencesContract, {
    clear: () => storage.removeItem(VECTOR_PREFERENCES_STORAGE_KEY),
    read: () => storage.getItem(VECTOR_PREFERENCES_STORAGE_KEY),
    write: (value) => storage.setItem(VECTOR_PREFERENCES_STORAGE_KEY, value),
  });

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
