import { hasDownloadedBuiltInLocalLlmModel } from '@brainstrike/assistant-contract/local-llm-artifacts';
import type { DbHandle, IDatabase } from '@brainstrike/db';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils/logger';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { isLocalModelProviderId } from '../models/local-model-utils';
import {
  getModelRegistryFetchErrorTestOverride,
  getModelRegistrySnapshotTestOverride,
} from '../settings-test-runtime-access';

const logger = createLogger('ModelRegistryStore');
let registryLoadPromise: Promise<void> | null = null;

export interface DbProvider {
  icon: string | null;
  id: string;
  isEnabled: boolean;
  name: string;
  sortOrder: number;
}

export interface DbModel {
  bestFor: string[] | null;
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
    /** Image-input support (LLM rows only; backfilled by migration 060). */
    vision?: boolean;
  };
  description: string | null;
  icon: string | null;
  id: string;
  isEnabled: boolean;
  name: string;
  parameters: Record<string, unknown> | null;
  providerId: string;
  sortOrder: number;
  tagline: string | null;
}

interface ModelRegistryState {
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>; // modelId -> progress %
  ensureRegistry: (db: IDatabase) => Promise<void>;
  error: string | null;

  // Actions
  fetchRegistry: (db: IDatabase) => Promise<void>;
  hasLoaded: boolean;
  isDownloading: Record<string, boolean>; // modelId -> boolean
  isLoading: boolean;

  modelCacheDir: string | null;
  models: DbModel[];
  providers: DbProvider[];
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  setModelCacheDir: (dir: string) => void;
  toggleModel: (db: DbHandle, modelId: string, enabled: boolean) => Promise<void>;
  toggleProvider: (db: DbHandle, providerId: string, enabled: boolean) => Promise<void>;
}

// Raw DB types
interface RawProvider {
  icon: string | null;
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  name: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
}

interface RawModel {
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  best_for: string | object | null;
  capabilities: string | object;
  description: string | null;
  icon: string | null;
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  name: string;
  parameters: string | object | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  provider_id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
  tagline: string | null;
}

interface FileSystemAccess {
  exists: (path: string) => Promise<boolean>;
}

async function checkLlmModelInCache(modelId: string): Promise<boolean> {
  try {
    return await hasDownloadedBuiltInLocalLlmModel(modelId);
  } catch (err) {
    logger.debug('Failed to check Cache API for model', { err, modelId });
    return false;
  }
}

function parseDbModel(row: RawModel): DbModel {
  return {
    bestFor: typeof row.best_for === 'string' ? JSON.parse(row.best_for) : row.best_for,
    capabilities:
      typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
    description: row.description,
    icon: row.icon,
    id: row.id,
    isEnabled: Boolean(row.is_enabled),
    name: row.name,
    parameters:
      typeof row.parameters === 'string' && row.parameters
        ? JSON.parse(row.parameters)
        : row.parameters,
    providerId: row.provider_id,
    sortOrder: row.sort_order,
    tagline: row.tagline,
  } as DbModel;
}

function isLocalModel(model: DbModel): boolean {
  return isLocalModelProviderId(model.providerId);
}

async function syncDurableDatabaseWrites(db: DbHandle): Promise<void> {
  await db.syncToFs?.();
}

async function resolveDownloadedFlag(
  model: DbModel,
  fileSystem: FileSystemAccess | undefined,
  modelCacheDir: string | null,
  currentDownloadedModels: Record<string, boolean>
): Promise<boolean> {
  // For LLM models, check the browser Cache API where LocalLlmBackend stores them
  if (model.capabilities.type === 'llm') {
    const inCache = await checkLlmModelInCache(model.id);
    if (inCache) {
      return true;
    }
    // Fall back to localStorage if Cache API check fails or returns false
    // (Cache might have been cleared by browser)
    return Boolean(currentDownloadedModels[model.id]);
  }

  // For embedding models, check filesystem if available
  if (fileSystem && modelCacheDir) {
    try {
      const modelPath = `${modelCacheDir}/${model.id}`;
      return await fileSystem.exists(modelPath);
    } catch (err) {
      logger.warn(`Failed to check existence for model ${model.id}`, err);
      return Boolean(currentDownloadedModels[model.id]);
    }
  }

  // Fall back to localStorage value
  return Boolean(currentDownloadedModels[model.id]);
}

async function checkDownloadedModels(
  models: DbModel[],
  modelCacheDir: string | null,
  currentDownloadedModels: Record<string, boolean>
): Promise<Record<string, boolean>> {
  const electronAPI = (
    window as unknown as {
      electronAPI?: { fileSystem?: FileSystemAccess };
    }
  ).electronAPI;

  const fileSystem = electronAPI?.fileSystem;

  const newDownloadedModels: Record<string, boolean> = {};

  const localModels = models.filter(isLocalModel);

  const results = await Promise.all(
    localModels.map(async (model) => {
      const isDownloaded = await resolveDownloadedFlag(
        model,
        fileSystem,
        modelCacheDir,
        currentDownloadedModels
      );
      return { id: model.id, isDownloaded };
    })
  );

  for (const { id, isDownloaded } of results) {
    if (isDownloaded) {
      newDownloadedModels[id] = true;
    }
  }

  return newDownloadedModels;
}

const initialState = {
  downloadedModels: {} as Record<string, boolean>,
  downloadProgress: {} as Record<string, number>,
  error: null as string | null,
  hasLoaded: false,
  isDownloading: {} as Record<string, boolean>,
  isLoading: false,
  modelCacheDir: null as string | null,
  models: [] as DbModel[],
  providers: [] as DbProvider[],
};

export const useModelRegistryStore = create<ModelRegistryState>()(
  persist(
    (set, get) => ({
      ...initialState,

      ensureRegistry: (db: IDatabase) => {
        const { hasLoaded, isLoading } = get();
        if (hasLoaded || isLoading) {
          return registryLoadPromise ?? Promise.resolve();
        }

        if (registryLoadPromise) {
          return registryLoadPromise;
        }

        registryLoadPromise = get()
          .fetchRegistry(db)
          .finally(() => {
            registryLoadPromise = null;
          });

        return registryLoadPromise;
      },

      fetchRegistry: async (db: IDatabase) => {
        set({ error: null, isLoading: true });
        try {
          const fetchErrorMessage = getModelRegistryFetchErrorTestOverride();
          if (fetchErrorMessage !== undefined && fetchErrorMessage !== null) {
            set({
              error: fetchErrorMessage,
              hasLoaded: false,
              isLoading: false,
            });
            return;
          }

          const snapshotOverride = getModelRegistrySnapshotTestOverride();
          if (snapshotOverride) {
            set({
              downloadedModels: snapshotOverride.downloadedModels ?? {},
              error: null,
              hasLoaded: true,
              isLoading: false,
              modelCacheDir: snapshotOverride.modelCacheDir ?? get().modelCacheDir,
              models: snapshotOverride.models ?? [],
              providers: snapshotOverride.providers ?? [],
            });
            return;
          }

          const providersResult = await db.query<RawProvider>(
            'SELECT * FROM providers ORDER BY sort_order ASC'
          );
          const modelsResult = await db.query<RawModel>(
            'SELECT * FROM models ORDER BY sort_order ASC'
          );

          const models = modelsResult.rows.map(parseDbModel);

          const providers = providersResult.rows.map((row: RawProvider) => ({
            icon: row.icon,
            id: row.id,
            isEnabled: Boolean(row.is_enabled),
            name: row.name,
            sortOrder: row.sort_order,
          }));

          // Check for existing downloads if in Electron environment
          const downloadedModels = await checkDownloadedModels(
            models,
            get().modelCacheDir,
            get().downloadedModels
          );

          set({ downloadedModels, hasLoaded: true, isLoading: false, models, providers });
        } catch (error) {
          logger.error('Failed to fetch model registry', error);
          set({ error: (error as Error).message, isLoading: false });
        }
      },

      setDownloading: (modelId: string, isDownloading: boolean) => {
        set((state) => ({
          isDownloading: { ...state.isDownloading, [modelId]: isDownloading },
        }));
      },

      setDownloadProgress: (modelId: string, progress: number) => {
        const roundedProgress = Math.min(100, Math.max(0, Math.round(progress)));
        const currentState = get();
        const completesDownload =
          roundedProgress === 100 && currentState.downloadedModels[modelId] !== true;
        if (currentState.downloadProgress[modelId] === roundedProgress && !completesDownload) {
          return;
        }
        set((state) => ({
          downloadedModels: completesDownload
            ? { ...state.downloadedModels, [modelId]: true }
            : state.downloadedModels,
          downloadProgress: {
            ...state.downloadProgress,
            [modelId]: roundedProgress,
          },
        }));
      },

      setModelCacheDir: (dir: string) => {
        set({ modelCacheDir: dir });
      },

      toggleModel: async (db: IDatabase, modelId: string, enabled: boolean) => {
        try {
          // Optimistic update
          set((state) => ({
            models: state.models.map((m) => (m.id === modelId ? { ...m, isEnabled: enabled } : m)),
          }));

          await db.query('UPDATE models SET is_enabled = $1, updated_at = NOW() WHERE id = $2', [
            enabled,
            modelId,
          ]);
          await syncDurableDatabaseWrites(db);

          set((state) => ({
            models: state.models.map((m) => (m.id === modelId ? { ...m, isEnabled: enabled } : m)),
          }));
        } catch (error) {
          logger.error('Failed to toggle model', error);
          void get().fetchRegistry(db);
        }
      },

      toggleProvider: async (db: IDatabase, providerId: string, enabled: boolean) => {
        try {
          // Optimistic update
          set((state) => ({
            providers: state.providers.map((p) =>
              p.id === providerId ? { ...p, isEnabled: enabled } : p
            ),
          }));

          await db.query('UPDATE providers SET is_enabled = $1, updated_at = NOW() WHERE id = $2', [
            enabled,
            providerId,
          ]);
          await syncDurableDatabaseWrites(db);

          set((state) => ({
            providers: state.providers.map((p) =>
              p.id === providerId ? { ...p, isEnabled: enabled } : p
            ),
          }));
        } catch (error) {
          logger.error('Failed to toggle provider', error);
          // Revert on error
          void get().fetchRegistry(db);
        }
      },
    }),
    {
      name: 'model-registry-storage',
      partialize: (state) => ({
        downloadedModels: state.downloadedModels,
        modelCacheDir: state.modelCacheDir,
      }),
      storage: createJSONStorage(() => createBrowserJsonStorage()),
    }
  )
);

/**
 * Reset the model registry store to its initial state.
 * Only use in tests to ensure a clean starting state between test runs.
 */
export function __resetModelRegistryStoreForTests() {
  try {
    registryLoadPromise = null;
    useModelRegistryStore.setState(initialState);
    const persistApi = (
      useModelRegistryStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
  }
}
