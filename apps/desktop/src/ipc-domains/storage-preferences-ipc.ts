import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { LayoutLoadResult, LayoutPersistenceResult } from '@brainstrike/ui';
import { ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { z } from 'zod';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  createDesktopIpcRegistry,
  type DesktopIpcSenderPolicy,
} from '../platform/desktop-ipc-registry';
import { VECTOR_PREFERENCES_STORAGE_KEY } from '../platform/vector-preferences-storage-key';
import type { DesktopSettingsStoreSchema } from '../store-schema';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly storage: ElectronStorageAdapter;
}

const logger = createLogger('StoragePreferencesIpc');

const panelPersistenceStateSchema = z.object({
  showConsole: z.boolean(),
  showLeftPanel: z.boolean(),
  showRightPanel: z.boolean(),
  sizes: z.array(
    z.number().superRefine((value, ctx) => {
      if (Number.isFinite(value)) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Panel size must be a finite number',
      });
    })
  ),
});

type PanelPersistenceState = z.infer<typeof panelPersistenceStateSchema>;
interface PanelLayoutEnvelope {
  readonly v1: PanelPersistenceState;
}
type DesktopSettingsStoreAccess = ElectronStore<DesktopSettingsStoreSchema> & {
  readonly clear: () => void;
  readonly get: (key: 'panelLayout') => unknown;
  readonly set: (key: 'panelLayout', value: PanelLayoutEnvelope) => void;
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

  registry.registerInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.getItem,
    async (_event, key: string) => storage.getItem(key)
  );
  registry.registerInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.setItem,
    async (_event, key: string, value: string) => storage.setItem(key, value)
  );
  registry.registerInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.removeItem,
    async (_event, key: string) => storage.removeItem(key)
  );
  registry.registerInvoke('storage', DESKTOP_IPC_CHANNELS.storage.clear, async () =>
    storage.clear()
  );
  registry.registerInvoke('storage', DESKTOP_IPC_CHANNELS.storage.getAllKeys, async () =>
    storage.getAllKeys()
  );

  // BST-1380: hidden inference hosts resolve their device preference from the
  // SAME canonical record the visible UI writes. They receive this scoped
  // capability instead of the unrestricted `storage` bridge above — the key is
  // pinned here, never supplied by the renderer, so a hidden host can neither
  // enumerate keys nor address another persisted store.
  const vectorPreferencesSenderPolicy = {
    roles: ['embedding-host'],
  } as const satisfies DesktopIpcSenderPolicy;

  registry.registerAuthorizedInvoke(
    'vectorPreferences',
    DESKTOP_IPC_CHANNELS.vectorPreferences.read,
    vectorPreferencesSenderPolicy,
    async () => storage.getItem(VECTOR_PREFERENCES_STORAGE_KEY)
  );
  registry.registerAuthorizedInvoke(
    'vectorPreferences',
    DESKTOP_IPC_CHANNELS.vectorPreferences.write,
    vectorPreferencesSenderPolicy,
    async (_event, value: string) => {
      if (typeof value !== 'string') {
        throw new TypeError('Vector preferences payload must be a string.');
      }
      return storage.setItem(VECTOR_PREFERENCES_STORAGE_KEY, value);
    }
  );
  registry.registerAuthorizedInvoke(
    'vectorPreferences',
    DESKTOP_IPC_CHANNELS.vectorPreferences.clear,
    vectorPreferencesSenderPolicy,
    async () => storage.removeItem(VECTOR_PREFERENCES_STORAGE_KEY)
  );

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.layoutSave,
    async (_event, state: unknown): Promise<LayoutPersistenceResult> => {
      const store = getSettingsStoreAccess(getStore);
      if (!store) {
        logger.warn('Cannot save layout: store not initialized');
        return { message: 'Store not initialized', success: false };
      }

      const parsed = panelPersistenceStateSchema.safeParse(state);
      if (!parsed.success) {
        logger.warn('Invalid panel layout payload', { issues: parsed.error.issues });
        return { message: 'Invalid panel layout payload', success: false };
      }

      try {
        store.set('panelLayout', { v1: parsed.data });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to save panel layout', { error: message });
        return { message, success: false };
      }
    }
  );

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.layoutLoad,
    async (): Promise<LayoutLoadResult> => {
      const store = getSettingsStoreAccess(getStore);
      if (!store) {
        logger.warn('Cannot load layout: store not initialized');
        return { message: 'Store not initialized', success: false };
      }

      try {
        const layout = store.get('panelLayout') as { v1?: unknown } | undefined;
        const candidate = layout?.v1;
        if (!candidate) {
          return { data: null, success: true };
        }

        const parsed = panelPersistenceStateSchema.safeParse(candidate);
        if (!parsed.success) {
          logger.warn('Invalid panel layout data in store', { issues: parsed.error.issues });
          return { message: 'Invalid panel layout data', success: false };
        }

        return { data: parsed.data, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to load panel layout', { error: message });
        return { message, success: false };
      }
    }
  );

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.settingsClearAll,
    async () => {
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
    }
  );

  return () => registry.unregisterAll();
}
