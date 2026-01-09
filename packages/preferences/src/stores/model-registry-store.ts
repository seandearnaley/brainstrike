import type { IDatabase } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const logger = createLogger('ModelRegistryStore');
let registryLoadPromise: Promise<void> | null = null;

export type DbProvider = {
  id: string;
  name: string;
  icon: string | null;
  isEnabled: boolean;
  sortOrder: number;
};

export type DbModel = {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  tagline: string | null;
  bestFor: string[] | null;
  icon: string | null;
  isEnabled: boolean;
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
  };
  parameters: Record<string, unknown> | null;
  sortOrder: number;
};

type ModelRegistryState = {
  providers: DbProvider[];
  models: DbModel[];
  isLoading: boolean;
  error: string | null;
  hasLoaded: boolean;

  modelCacheDir: string | null;
  downloadProgress: Record<string, number>; // modelId -> progress %
  isDownloading: Record<string, boolean>; // modelId -> boolean

  // Actions
  fetchRegistry: (db: IDatabase) => Promise<void>;
  ensureRegistry: (db: IDatabase) => Promise<void>;
  toggleProvider: (db: IDatabase, providerId: string, enabled: boolean) => Promise<void>;
  toggleModel: (db: IDatabase, modelId: string, enabled: boolean) => Promise<void>;
  setModelCacheDir: (dir: string) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  downloadedModels: Record<string, boolean>;
};

// Raw DB types
type RawProvider = {
  id: string;
  name: string;
  icon: string | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
};

type RawModel = {
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  provider_id: string;
  name: string;
  description: string | null;
  tagline: string | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  best_for: string | object | null;
  icon: string | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  capabilities: string | object;
  parameters: string | object | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
};

type FileSystemAccess = {
  exists: (path: string) => Promise<boolean>;
};

/**
 * Get the ONNX model file to check for in cache based on model type.
 * This matches the dtype logic in LocalLlmBackend.downloadModel().
 * Qwen models use q4f16, others use q4.
 */
function getModelCacheFile(modelId: string): string {
  if (modelId.includes('Qwen')) {
    return 'onnx/model_q4f16.onnx';
  }
  return 'onnx/model_q4.onnx';
}

/**
 * Check if an LLM model exists in the browser Cache API.
 * This matches how LocalLlmBackend.downloadModel() stores files.
 */
async function checkLlmModelInCache(modelId: string): Promise<boolean> {
  if (typeof caches === 'undefined') {
    return false;
  }

  try {
    const cache = await caches.open('transformers-cache');
    // Check for the main ONNX model file - model-specific based on dtype
    const modelFile = getModelCacheFile(modelId);
    const modelUrl = `https://huggingface.co/${modelId}/resolve/main/${modelFile}`;
    const cached = await cache.match(modelUrl);
    return cached !== undefined;
  } catch (err) {
    logger.debug('Failed to check Cache API for model', { modelId, err });
    return false;
  }
}

function parseDbModel(row: RawModel): DbModel {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    description: row.description,
    tagline: row.tagline,
    bestFor: typeof row.best_for === 'string' ? JSON.parse(row.best_for) : row.best_for,
    icon: row.icon,
    isEnabled: Boolean(row.is_enabled),
    capabilities:
      typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
    parameters:
      typeof row.parameters === 'string' && row.parameters
        ? JSON.parse(row.parameters)
        : row.parameters,
    sortOrder: row.sort_order,
  } as DbModel;
}

function isLocalModel(model: DbModel): boolean {
  return model.providerId === 'transformers' || model.providerId === 'local';
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

  for (const model of models) {
    if (!isLocalModel(model)) {
      continue;
    }

    const isDownloaded = await resolveDownloadedFlag(
      model,
      fileSystem,
      modelCacheDir,
      currentDownloadedModels
    );

    if (isDownloaded) {
      newDownloadedModels[model.id] = true;
    }
  }

  return newDownloadedModels;
}

const initialState = {
  providers: [] as DbProvider[],
  models: [] as DbModel[],
  isLoading: false,
  error: null as string | null,
  hasLoaded: false,
  modelCacheDir: null as string | null,
  downloadProgress: {} as Record<string, number>,
  isDownloading: {} as Record<string, boolean>,
  downloadedModels: {} as Record<string, boolean>,
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
        set({ isLoading: true, error: null });
        try {
          const providersResult = await db.query<RawProvider>(
            'SELECT * FROM providers ORDER BY sort_order ASC'
          );
          const modelsResult = await db.query<RawModel>(
            'SELECT * FROM models ORDER BY sort_order ASC'
          );

          const models = modelsResult.rows.map(parseDbModel);

          const providers = providersResult.rows.map((row: RawProvider) => ({
            id: row.id,
            name: row.name,
            icon: row.icon,
            isEnabled: Boolean(row.is_enabled),
            sortOrder: row.sort_order,
          }));

          // Check for existing downloads if in Electron environment
          const downloadedModels = await checkDownloadedModels(
            models,
            get().modelCacheDir,
            get().downloadedModels
          );

          set({ providers, models, downloadedModels, isLoading: false, hasLoaded: true });
        } catch (error) {
          logger.error('Failed to fetch model registry', error);
          set({ error: (error as Error).message, isLoading: false });
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
        } catch (error) {
          logger.error('Failed to toggle provider', error);
          // Revert on error
          void get().fetchRegistry(db);
        }
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
        } catch (error) {
          logger.error('Failed to toggle model', error);
          void get().fetchRegistry(db);
        }
      },

      setModelCacheDir: (dir: string) => {
        set({ modelCacheDir: dir });
      },

      setDownloadProgress: (modelId: string, progress: number) => {
        set((state) => {
          const downloadedModels = { ...state.downloadedModels };
          if (progress === 100) {
            downloadedModels[modelId] = true;
          }
          return {
            downloadProgress: { ...state.downloadProgress, [modelId]: progress },
            downloadedModels,
          };
        });
      },

      setDownloading: (modelId: string, isDownloading: boolean) => {
        set((state) => ({
          isDownloading: { ...state.isDownloading, [modelId]: isDownloading },
        }));
      },
    }),
    {
      name: 'model-registry-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        modelCacheDir: state.modelCacheDir,
        downloadedModels: state.downloadedModels,
      }),
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
