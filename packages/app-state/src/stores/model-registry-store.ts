import type {
  CatalogModel,
  CatalogProvider,
  ModelCatalogCapability,
  ModelCatalogSnapshot,
  ProviderModelDefaultPolicy,
} from '@brainstrike/assistant-contract';
import {
  describeBoundaryError,
  isBoundaryRefusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import { create } from 'zustand';
import {
  getModelRegistryFetchErrorTestOverride,
  getModelRegistrySnapshotTestOverride,
} from '../automation-overrides';

const logger = createLogger('ModelRegistryStore');
let registryLoadPromise: Promise<void> | null = null;

export type DbProvider = CatalogProvider;
export type DbModel = CatalogModel;
export type ModelRegistrySource = ModelCatalogCapability;

function registrySnapshot(snapshot: ModelCatalogSnapshot): {
  models: DbModel[];
  providers: DbProvider[];
} {
  return { models: [...snapshot.models], providers: [...snapshot.providers] };
}

interface ModelRegistryState {
  /**
   * Applies a model cache read that began when `downloadSequence` was
   * `readStartedAt` (BST-2241): `downloadedModels` becomes the realm's answer
   * plus every download completed since the read began, which that answer may
   * predate. A read that failed is an empty answer, so no earlier answer stands.
   */
  applyDownloadedModelsRead: (modelIds: readonly string[], readStartedAt: number) => void;
  /** Each completed download's place in `downloadSequence`, so a slower read keeps it. */
  completedDownloads: Record<string, number>;
  /**
   * Local models whose download plans are fully in the embedding realm's model
   * cache, as that realm last reported (BST-2241), plus downloads completed since.
   * Never persisted: only the realm's cache says what is downloaded.
   */
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>; // modelId -> progress %
  /** Counts completed downloads; a cache read notes it when it begins. */
  downloadSequence: number;
  ensureRegistry: (db: ModelRegistrySource) => Promise<void>;
  error: string | null;

  // Actions
  fetchRegistry: (db: ModelRegistrySource) => Promise<void>;
  hasLoaded: boolean;
  initializeProviderModelDefaults: (
    db: ModelRegistrySource,
    providerId: string,
    policy: ProviderModelDefaultPolicy
  ) => Promise<'initialized' | 'preserved'>;
  isDownloading: Record<string, boolean>; // modelId -> boolean
  isLoading: boolean;

  models: DbModel[];
  providers: DbProvider[];
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  /**
   * Enables or disables many models in ONE atomic statement (BST-1805) and
   * resolves with each id's PRIOR enabled state, for Undo.
   *
   * Refuses up front — before the optimistic update, so with no restore, no
   * refresh and no log — when the id list is empty, or when an id is not in
   * the loaded registry.
   *
   * Otherwise rejects — after restoring those exact prior states and
   * scheduling a registry refresh — when the write fails, or when any id is
   * missing from the database (in which case nothing is written).
   */
  setModelsEnabled: (
    db: ModelRegistrySource,
    modelIds: readonly string[],
    enabled: boolean
  ) => Promise<ReadonlyMap<string, boolean>>;
  toggleModel: (db: ModelRegistrySource, modelId: string, enabled: boolean) => Promise<void>;
  toggleProvider: (db: ModelRegistrySource, providerId: string, enabled: boolean) => Promise<void>;
}

const initialState = {
  completedDownloads: {} as Record<string, number>,
  downloadedModels: {} as Record<string, boolean>,
  downloadProgress: {} as Record<string, number>,
  downloadSequence: 0,
  error: null as string | null,
  hasLoaded: false,
  isDownloading: {} as Record<string, boolean>,
  isLoading: false,
  models: [] as DbModel[],
  providers: [] as DbProvider[],
};

export const useModelRegistryStore = create<ModelRegistryState>()((set, get) => ({
  ...initialState,

  applyDownloadedModelsRead: (modelIds: readonly string[], readStartedAt: number) => {
    set((state) => ({
      downloadedModels: Object.fromEntries([
        ...modelIds.map((id) => [id, true] as const),
        ...Object.entries(state.completedDownloads).flatMap(([id, completedAt]) =>
          completedAt > readStartedAt ? [[id, true] as const] : []
        ),
      ]),
    }));
  },

  ensureRegistry: (db: ModelRegistrySource) => {
    const { error, hasLoaded, isLoading } = get();
    if (hasLoaded || isLoading) {
      return registryLoadPromise ?? Promise.resolve();
    }
    // After a failed fetch only an explicit Retry or Refresh (fetchRegistry) tries again.
    // A consumer that mounts later must not refetch: each attempt clears the error and
    // remounts the error view, which can swallow the user's click on Retry.
    if (error !== null) {
      return Promise.resolve();
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

  fetchRegistry: async (db: ModelRegistrySource) => {
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
          models: snapshotOverride.models ?? [],
          providers: snapshotOverride.providers ?? [],
        });
        return;
      }

      const snapshot = registrySnapshot(await db.read());
      set({ ...snapshot, hasLoaded: true, isLoading: false });
    } catch (error) {
      // A refusal (the profile is closed for a reset or quit) is unavailability.
      if (isBoundaryRefusal(error)) {
        logger.warn('Model registry is unavailable', error);
      } else {
        logger.error('Failed to fetch model registry', error);
      }
      set({ error: describeBoundaryError(error), isLoading: false });
    }
  },

  initializeProviderModelDefaults: async (db, providerId, policy) => {
    const result = await db.initializeProviderDefaults(providerId, policy);
    set(registrySnapshot(result.snapshot));
    return result.outcome;
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
      ...(completesDownload
        ? {
            completedDownloads: {
              ...state.completedDownloads,
              [modelId]: state.downloadSequence + 1,
            },
            downloadSequence: state.downloadSequence + 1,
          }
        : {}),
      downloadedModels: completesDownload
        ? { ...state.downloadedModels, [modelId]: true }
        : state.downloadedModels,
      downloadProgress: {
        ...state.downloadProgress,
        [modelId]: roundedProgress,
      },
    }));
  },

  setModelsEnabled: async (
    db: ModelRegistrySource,
    modelIds: readonly string[],
    enabled: boolean
  ) => {
    const uniqueIds = Array.from(new Set(modelIds));
    if (uniqueIds.length === 0) {
      throw new Error('Choose at least one model to update.');
    }
    const knownIds = new Set(get().models.map((model) => model.id));
    const unknownIds = uniqueIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`These models are not in the loaded registry: ${unknownIds.join(', ')}`);
    }

    const result = await db.setModels(uniqueIds, enabled);
    set(registrySnapshot(result.snapshot));
    return new Map(
      result.previous.map(({ modelId, enabled: previousEnabled }) => [modelId, previousEnabled])
    );
  },

  toggleModel: async (db: ModelRegistrySource, modelId: string, enabled: boolean) => {
    await get().setModelsEnabled(db, [modelId], enabled);
  },

  toggleProvider: async (db: ModelRegistrySource, providerId: string, enabled: boolean) => {
    set(registrySnapshot(await db.setProvider(providerId, enabled)));
  },
}));

/**
 * Reset the model registry store to its initial state.
 * Only use in tests to ensure a clean starting state between test runs.
 */
export function __resetModelRegistryStoreForTests() {
  try {
    registryLoadPromise = null;
    useModelRegistryStore.setState(initialState);
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
  }
}
