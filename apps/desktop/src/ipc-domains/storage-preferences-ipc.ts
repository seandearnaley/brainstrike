import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { LayoutLoadResult, LayoutPersistenceResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { z } from 'zod';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import type { DesktopSettingsStoreSchema } from '../store-schema';

interface RegisterStoragePreferencesIpcHandlersOptions {
  readonly getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly storage: ElectronStorageAdapter;
}

const logger = createLogger('StoragePreferencesIpc');

const panelPersistenceStateSchema = z.object({
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
  showConsole: z.boolean(),
  showLeftPanel: z.boolean(),
  showRightPanel: z.boolean(),
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

  registry.registerInvoke('storage', 'storage:getItem', async (_event, key: string) =>
    storage.getItem(key)
  );
  registry.registerInvoke(
    'storage',
    'storage:setItem',
    async (_event, key: string, value: string) => storage.setItem(key, value)
  );
  registry.registerInvoke('storage', 'storage:removeItem', async (_event, key: string) =>
    storage.removeItem(key)
  );
  registry.registerInvoke('storage', 'storage:clear', async () => storage.clear());
  registry.registerInvoke('storage', 'storage:getAllKeys', async () => storage.getAllKeys());

  registry.registerInvoke(
    'preferences',
    'layout:save',
    async (_event, state: unknown): Promise<LayoutPersistenceResult> => {
      const store = getSettingsStoreAccess(getStore);
      if (!store) {
        logger.warn('Cannot save layout: store not initialized');
        return { success: false, message: 'Store not initialized' };
      }

      const parsed = panelPersistenceStateSchema.safeParse(state);
      if (!parsed.success) {
        logger.warn('Invalid panel layout payload', { issues: parsed.error.issues });
        return { success: false, message: 'Invalid panel layout payload' };
      }

      try {
        store.set('panelLayout', { v1: parsed.data });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to save panel layout', { error: message });
        return { success: false, message };
      }
    }
  );

  registry.registerInvoke('preferences', 'layout:load', async (): Promise<LayoutLoadResult> => {
    const store = getSettingsStoreAccess(getStore);
    if (!store) {
      logger.warn('Cannot load layout: store not initialized');
      return { success: false, message: 'Store not initialized' };
    }

    try {
      const layout = store.get('panelLayout') as { v1?: unknown } | undefined;
      const candidate = layout?.v1;
      if (!candidate) {
        return { success: true, data: null };
      }

      const parsed = panelPersistenceStateSchema.safeParse(candidate);
      if (!parsed.success) {
        logger.warn('Invalid panel layout data in store', { issues: parsed.error.issues });
        return { success: false, message: 'Invalid panel layout data' };
      }

      return { success: true, data: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to load panel layout', { error: message });
      return { success: false, message };
    }
  });

  registry.registerInvoke('preferences', 'settings:clearAll', async () => {
    try {
      const store = getSettingsStoreAccess(getStore);
      if (!store) {
        return { success: false, message: 'Store not initialized' };
      }
      store.clear();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return () => registry.unregisterAll();
}
