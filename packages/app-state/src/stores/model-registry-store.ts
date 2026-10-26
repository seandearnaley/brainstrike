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
} from '../automation-overrides.ts';

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
  isLoading: boolean;

  models: DbModel[];
  providers: DbProvider[];
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
  error: null as string | null,
  hasLoaded: false,
  isLoading: false,
  models: [] as DbModel[],
  providers: [] as DbProvider[],
};

export const useModelRegistryStore = create<ModelRegistryState>()((set, get) => ({
  ...initialState,

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
