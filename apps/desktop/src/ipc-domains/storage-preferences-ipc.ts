import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import {
  assertRendererWritableDesktopStorageKey,
  isMainOwnedDesktopStorageKey,
} from '../platform/desktop-storage-authority';
import { NoArgs } from '../platform/ipc-args';
import { storageContract } from './storage-preferences.contract';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly storage: ElectronStorageAdapter;
}

export function registerStoragePreferencesIpcHandlers({
  storage,
}: RegisterStoragePreferencesIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  const key = Schema.Tuple([Schema.String]);
  registerDomain(
    registry,
    'storage',
    storageContract,
    {
      getAllKeys: NoArgs,
      getItem: key,
      removeItem: key,
      setItem: Schema.Tuple([Schema.String, Schema.String]),
    },
    {
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
    }
  );

  if (isElectronE2ETestMode()) {
    // These channels deliberately remain a conditional adapter instead of a
    // discoverable contract: production must not register them, while the
    // global contract manifest requires every exported invoke unconditionally.
    registry.handle(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
      Schema.Tuple([Schema.String, Schema.String]),
      async (_event, mainOwnedKey, value) => {
        if (!isMainOwnedDesktopStorageKey(mainOwnedKey)) {
          throw new Error('E2E main-owned storage seed requires a main-owned key.');
        }
        return storage.setItem(mainOwnedKey, value);
      }
    );
    registry.handle('storage', DESKTOP_IPC_CHANNELS.storage.clearAllForE2e, NoArgs, async () =>
      storage.clear()
    );
  }

  return () => registry.unregisterAll();
}
