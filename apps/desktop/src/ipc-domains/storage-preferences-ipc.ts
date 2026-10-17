import { wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { LayoutLoadResult, LayoutPersistenceResult } from '@brainstrike/ui';
import { Schema, SchemaIssue } from 'effect';
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
import { VECTOR_PREFERENCES_STORAGE_KEY } from '../platform/vector-preferences-storage-key';
import type { DesktopSettingsStoreSchema } from '../store-schema';
import {
  layoutContract,
  settingsContract,
  storageContract,
  vectorPreferencesContract,
} from './storage-preferences.contract';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly onStorageChanged?: (key: string) => void;
  readonly storage: ElectronStorageAdapter;
}

const logger = createLogger('StoragePreferencesIpc');

const panelPersistenceStateSchema = Schema.Struct({
  showConsole: Schema.Boolean,
  showLeftPanel: Schema.Boolean,
  showRightPanel: Schema.Boolean,
  sizes: Schema.mutable(
    Schema.Array(
      Schema.Finite.check(
        Schema.makeFilter((value) => {
          const issues: { issue: string; path: readonly PropertyKey[] }[] = [];
          if (Number.isFinite(value)) {
            return issues;
          }
          issues.push({ issue: 'Panel size must be a finite number', path: [] });
          return issues;
        })
      )
    )
  ),
});

type PanelPersistenceState = (typeof panelPersistenceStateSchema)['Type'];
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
  onStorageChanged,
}: RegisterStoragePreferencesIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registerDomain(registry, 'storage', storageContract, {
    clear: async () => {
      // Renderer factory-reset cleanup may clear preference slices, but only
      // desktop main's reset barrier may erase root/vault authority ledgers.
      await storage.clearExcept(MAIN_OWNED_DESKTOP_STORAGE_KEYS);
    },
    getAllKeys: () => storage.getAllKeys(),
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => {
      assertRendererWritableDesktopStorageKey(key);
      return storage.removeItem(key);
    },
    setItem: async (key, value) => {
      assertRendererWritableDesktopStorageKey(key);
      const previous = await storage.getItem(key);
      await storage.setItem(key, value);
      if (previous !== value) {
        onStorageChanged?.(key);
      }
    },
  });

  if (isElectronE2ETestMode()) {
    // These channels deliberately remain a conditional adapter instead of a
    // discoverable contract: production must not register them, while the
    // global contract manifest requires every exported invoke unconditionally.
    const visibleUiPolicy = { roles: ['visible-ui'] } as const;
    registry.registerAuthorizedInvoke(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
      visibleUiPolicy,
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
    registry.registerAuthorizedInvoke(
      'storage',
      DESKTOP_IPC_CHANNELS.storage.clearAllForE2e,
      visibleUiPolicy,
      async () => storage.clear()
    );
  }

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

  registerDomain(registry, 'preferences', layoutContract, {
    loadLayout: async (): Promise<LayoutLoadResult> => {
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

        const parsed = wireResultDecoder(panelPersistenceStateSchema, { errors: 'all' })(candidate);
        if (!(parsed._tag === 'Success')) {
          logger.warn('Invalid panel layout data in store', {
            issues: SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues,
          });
          return { message: 'Invalid panel layout data', success: false };
        }

        return { data: parsed.success, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to load panel layout', { error: message });
        return { message, success: false };
      }
    },
    saveLayout: async (state): Promise<LayoutPersistenceResult> => {
      const store = getSettingsStoreAccess(getStore);
      if (!store) {
        logger.warn('Cannot save layout: store not initialized');
        return { message: 'Store not initialized', success: false };
      }

      const parsed = wireResultDecoder(panelPersistenceStateSchema, { errors: 'all' })(state);
      if (!(parsed._tag === 'Success')) {
        logger.warn('Invalid panel layout payload', {
          issues: SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues,
        });
        return { message: 'Invalid panel layout payload', success: false };
      }

      try {
        store.set('panelLayout', { v1: parsed.success });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to save panel layout', { error: message });
        return { message, success: false };
      }
    },
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
