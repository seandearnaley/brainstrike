import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { LayoutLoadResult, LayoutPersistenceResult } from '@brainstrike/ui';
import { ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { z } from 'zod';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  createDesktopIpcRegistry,
  type DesktopIpcSenderPolicy,
} from '../platform/desktop-ipc-registry';
import {
  assertRendererWritableDesktopStorageKey,
  isMainOwnedDesktopStorageKey,
  MAIN_OWNED_DESKTOP_STORAGE_KEYS,
} from '../platform/desktop-storage-authority';
import { VECTOR_PREFERENCES_STORAGE_KEY } from '../platform/vector-preferences-storage-key';
import type { DesktopSettingsStoreSchema } from '../store-schema';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

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

  registry.registerUnauthenticatedInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.getItem,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, key: string) => storage.getItem(key)
  );
  registry.registerUnauthenticatedInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.setItem,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, key: unknown, value: unknown) => {
      assertRendererWritableDesktopStorageKey(key);
      if (typeof value !== 'string') {
        throw new TypeError('Storage value must be a string.');
      }
      return storage.setItem(key, value);
    }
  );
  registry.registerUnauthenticatedInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.removeItem,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, key: unknown) => {
      assertRendererWritableDesktopStorageKey(key);
      return storage.removeItem(key);
    }
  );
  registry.registerUnauthenticatedInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.clear,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => {
      // Renderer factory-reset cleanup may clear preference slices, but only
      // desktop main's reset barrier may erase root/vault authority ledgers.
      await storage.clearExcept(MAIN_OWNED_DESKTOP_STORAGE_KEYS);
    }
  );
  registry.registerUnauthenticatedInvoke(
    'storage',
    DESKTOP_IPC_CHANNELS.storage.getAllKeys,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => storage.getAllKeys()
  );

  if (isElectronE2ETestMode()) {
    // Existing desktop E2E boots from exact persisted-root fixtures. Keep that
    // setup authority on a separately registered test-only channel instead of
    // weakening the production mutation guard.
    registry.registerUnauthenticatedInvoke(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
      UNAUTHENTICATED_SENDER_POLICY,
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
    registry.registerUnauthenticatedInvoke(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.clearAllForE2e,
      UNAUTHENTICATED_SENDER_POLICY,
      async () => storage.clear()
    );
  }

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

  registry.registerUnauthenticatedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.layoutSave,
    UNAUTHENTICATED_SENDER_POLICY,
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

  registry.registerUnauthenticatedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.layoutLoad,
    UNAUTHENTICATED_SENDER_POLICY,
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

  registry.registerUnauthenticatedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.preferences.settingsClearAll,
    UNAUTHENTICATED_SENDER_POLICY,
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
