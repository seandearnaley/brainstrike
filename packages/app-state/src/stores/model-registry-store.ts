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
import {
  type BoundaryTransport,
  callBoundary,
} from '@brainstrike/assistant-contract/boundary-result';
import { hasDownloadedBuiltInLocalLlmModel } from '@brainstrike/assistant-contract/local-llm-artifacts';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  getModelRegistryFetchErrorTestOverride,
  getModelRegistrySnapshotTestOverride,
} from '../automation-overrides';
import { isLocalModelProviderId } from '../models/local-model-utils';
import { clearPersistedStorageForTests } from './persist-api';

const logger = createLogger('ModelRegistryStore');
let registryLoadPromise: Promise<void> | null = null;

export type DbProvider = CatalogProvider;
export type DbModel = CatalogModel;
export type ModelRegistrySource = DbHandle | ModelCatalogCapability;

function isCatalogCapability(source: ModelRegistrySource): source is ModelCatalogCapability {
  return 'read' in source;
}

function registrySnapshot(snapshot: ModelCatalogSnapshot): {
  models: DbModel[];
  providers: DbProvider[];
} {
  return { models: [...snapshot.models], providers: [...snapshot.providers] };
}

interface ModelRegistryState {
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>; // modelId -> progress %
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

  modelCacheDir: string | null;
  models: DbModel[];
  providers: DbProvider[];
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  setModelCacheDir: (dir: string) => void;
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

interface RawProviderModelChoice {
  capabilities: string | { type?: unknown } | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  created_at: Date | string;
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  updated_at: Date | string;
}

function timestampMillis(value: Date | string, field: 'created_at' | 'updated_at'): number {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`Model registry returned an invalid ${field} timestamp.`);
  }
  return millis;
}

function hasExplicitProviderModelChoice(rows: readonly RawProviderModelChoice[]): boolean {
  let hasExplicitChoice = false;
  for (const row of rows) {
    const updatedAt = timestampMillis(row.updated_at, 'updated_at');
    const createdAt = timestampMillis(row.created_at, 'created_at');
    hasExplicitChoice ||= Boolean(row.is_enabled) || updatedAt > createdAt;
  }
  return hasExplicitChoice;
}

function isLlmChoiceRow(row: RawProviderModelChoice): boolean {
  if (typeof row.capabilities === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.capabilities);
    } catch (error) {
      throw new Error(`Model registry row ${row.id} has unparseable capabilities.`, {
        cause: error,
      });
    }
    // A parsed value that is not a non-null object is not a catalog LLM row
    // (e.g. the JSON text 'null' parses to null, matching SQL NULL).
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    return (parsed as { type?: unknown }).type === 'llm';
  }
  // A missing/non-object capabilities value is not a catalog LLM row.
  if (typeof row.capabilities !== 'object' || row.capabilities === null) {
    return false;
  }
  return row.capabilities.type === 'llm';
}

/**
 * A row no user has ever acted on. Requires BOTH conjuncts: `updated_at ===
 * created_at` alone would be enough on paper, but demanding `!is_enabled` as
 * well means this predicate can only ever select a row to turn ON. No path
 * through the availability policy can revoke a model the user is using.
 */
function isUntouchedChoiceRow(row: RawProviderModelChoice): boolean {
  if (row.is_enabled) {
    return false;
  }
  return (
    timestampMillis(row.updated_at, 'updated_at') === timestampMillis(row.created_at, 'created_at')
  );
}

/** Ids the `all` policy may enable: LLM rows no user has acted on. */
function selectUntouchedLlmModelIds(rows: readonly RawProviderModelChoice[]): string[] {
  const modelIds: string[] = [];
  for (const row of rows) {
    // LLM check first: embedding rows must never reach the timestamp parse.
    if (isLlmChoiceRow(row) && isUntouchedChoiceRow(row)) {
      modelIds.push(row.id);
    }
  }
  return modelIds;
}

function validateSeedModelIds(
  rows: readonly RawProviderModelChoice[],
  providerId: string,
  modelIds: readonly string[]
): string[] {
  // Dedupe + empty-throw first: this does not depend on the query, and
  // an empty seed set against a curated provider must throw rather than
  // silently return 'preserved' through the gate below.
  const uniqueModelIds = Array.from(new Set(modelIds));
  if (uniqueModelIds.length === 0) {
    throw new Error(`No recommended model defaults were provided for ${providerId}.`);
  }
  // Validate seed/catalog drift BEFORE the curated-provider gate: a
  // seed id absent from the DB must throw even when the provider is
  // already curated, rather than being hidden behind an early
  // 'preserved' return.
  const choicesById = new Map(rows.map((row) => [row.id, row]));
  const missingModelIds = uniqueModelIds.filter((modelId) => !choicesById.has(modelId));
  if (missingModelIds.length > 0) {
    throw new Error(
      `Recommended ${providerId} models are missing from the catalog: ${missingModelIds.join(', ')}`
    );
  }
  return uniqueModelIds;
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
    const modelPath = `${modelCacheDir}/${model.id}`;
    return fileSystem.exists(modelPath);
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
      electronAPI?: { fileSystem?: BoundaryTransport<FileSystemAccess> };
    }
  ).electronAPI;

  const transport = electronAPI?.fileSystem;
  const fileSystem = transport
    ? { exists: (modelPath: string) => callBoundary(() => transport.exists(modelPath)) }
    : undefined;

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
              modelCacheDir: snapshotOverride.modelCacheDir ?? get().modelCacheDir,
              models: snapshotOverride.models ?? [],
              providers: snapshotOverride.providers ?? [],
            });
            return;
          }

          if (isCatalogCapability(db)) {
            const snapshot = registrySnapshot(await db.read());
            const downloadedModels = await checkDownloadedModels(
              snapshot.models,
              get().modelCacheDir,
              get().downloadedModels
            );
            set({ ...snapshot, downloadedModels, hasLoaded: true, isLoading: false });
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
        if (isCatalogCapability(db)) {
          const result = await db.initializeProviderDefaults(providerId, policy);
          set(registrySnapshot(result.snapshot));
          return result.outcome;
        }

        const choiceResult = await db.query<RawProviderModelChoice>(
          `SELECT id, is_enabled, capabilities, created_at, updated_at
           FROM models WHERE provider_id = $1`,
          [providerId]
        );

        let uniqueModelIds: string[];
        if (policy.kind === 'all') {
          // Availability policy: every LLM row nobody has acted on. Ids come
          // from the DB itself, so catalog/DB drift cannot arise here and
          // there is nothing to validate against.
          uniqueModelIds = selectUntouchedLlmModelIds(choiceResult.rows);
        } else {
          // Starter kit: unchanged behaviour. One enabled or edited row in the
          // provider means the user has curated it; do not impose a set.
          uniqueModelIds = validateSeedModelIds(choiceResult.rows, providerId, policy.modelIds);
          if (hasExplicitProviderModelChoice(choiceResult.rows)) {
            return 'preserved';
          }
        }

        if (uniqueModelIds.length === 0) {
          return 'preserved';
        }

        const placeholders = uniqueModelIds.map((_, index) => `$${index + 2}`).join(', ');
        const isAllPolicy = policy.kind === 'all';
        // The `all` policy re-asserts the eligibility predicates the TS-side
        // selection just used, so a row another writer touched between the
        // SELECT and this UPDATE (e.g. the user disabling it) cannot be
        // re-enabled out from under them — RETURNING then simply omits that
        // row rather than the UPDATE clobbering it. The predicates are not
        // byte-identical: TS `timestampMillis` compares at millisecond
        // resolution while SQL `updated_at = created_at` compares at
        // microsecond resolution, so a sub-millisecond skew between the two
        // columns can make a row TS-eligible but SQL-ineligible. That skew
        // only narrows the UPDATE, never widens it, so it fails safe — it
        // never over-enables a row. The `seed` policy is unchanged: a short
        // RETURNING set there is a real drift tripwire and must keep
        // throwing.
        const allPolicyClause = isAllPolicy
          ? " AND is_enabled = false AND updated_at = created_at AND capabilities->>'type' = 'llm'"
          : '';
        const updateResult = await db.query<{ id: string }>(
          `UPDATE models SET is_enabled = true, updated_at = NOW()
           WHERE provider_id = $1 AND id IN (${placeholders})${allPolicyClause}
           RETURNING id`,
          [providerId, ...uniqueModelIds]
        );
        const updatedModelIds = new Set(updateResult.rows.map((row) => row.id));

        if (isAllPolicy) {
          // A short RETURNING set here means another writer touched those
          // rows concurrently (e.g. the user disabled one) — skip them
          // rather than treat it as drift; the seed path below still throws.
          if (updatedModelIds.size === 0) {
            return 'preserved';
          }
        } else {
          const notUpdatedModelIds = uniqueModelIds.filter(
            (modelId) => !updatedModelIds.has(modelId)
          );
          if (notUpdatedModelIds.length > 0) {
            throw new Error(
              `Failed to initialize recommended ${providerId} models: ${notUpdatedModelIds.join(', ')}`
            );
          }
        }

        await syncDurableDatabaseWrites(db);
        set((state) => ({
          models: state.models.map((model) =>
            model.providerId === providerId && updatedModelIds.has(model.id)
              ? { ...model, isEnabled: true }
              : model
          ),
        }));
        return 'initialized';
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

      setModelsEnabled: async (
        db: ModelRegistrySource,
        modelIds: readonly string[],
        enabled: boolean
      ) => {
        const uniqueIds = Array.from(new Set(modelIds));
        if (uniqueIds.length === 0) {
          throw new Error('Choose at least one model to update.');
        }
        const modelsById = new Map(get().models.map((model) => [model.id, model]));
        const previous = new Map<string, boolean>();
        const unknownIds: string[] = [];
        for (const id of uniqueIds) {
          const model = modelsById.get(id);
          if (model) {
            previous.set(id, model.isEnabled);
          } else {
            unknownIds.push(id);
          }
        }
        if (unknownIds.length > 0) {
          throw new Error(`These models are not in the loaded registry: ${unknownIds.join(', ')}`);
        }

        if (isCatalogCapability(db)) {
          const result = await db.setModels(uniqueIds, enabled);
          set(registrySnapshot(result.snapshot));
          return new Map(
            result.previous.map(({ modelId, enabled: previousEnabled }) => [
              modelId,
              previousEnabled,
            ])
          );
        }

        const applyStates = (resolve: (id: string) => boolean): void => {
          set((state) => ({
            models: state.models.map((model) =>
              previous.has(model.id) ? { ...model, isEnabled: resolve(model.id) } : model
            ),
          }));
        };

        // Optimistic update.
        applyStates(() => enabled);
        try {
          // ONE statement for every id. The count guard makes it all-or-nothing:
          // if any id is missing from the table, no row is updated, so a short
          // RETURNING set can never be a partial write.
          const result = await db.query<{ id: string }>(
            `UPDATE models SET is_enabled = $1, updated_at = NOW()
             WHERE id = ANY($2)
               AND (SELECT count(*) FROM models WHERE id = ANY($2)) = $3
             RETURNING id`,
            [enabled, uniqueIds, uniqueIds.length]
          );
          if (result.rows.length !== uniqueIds.length) {
            throw new Error(
              'Some of these models are missing from the database, so nothing was changed.'
            );
          }
          await syncDurableDatabaseWrites(db);
          // Re-apply over any refresh that landed mid-write (toggleModel parity).
          applyStates(() => enabled);
          return previous;
        } catch (error) {
          logger.error('Failed to update models', error);
          applyStates((id) => previous.get(id) === true);
          void get().fetchRegistry(db);
          throw error;
        }
      },

      toggleModel: async (db: ModelRegistrySource, modelId: string, enabled: boolean) => {
        if (isCatalogCapability(db)) {
          await get().setModelsEnabled(db, [modelId], enabled);
          return;
        }

        const previousModel = get().models.find((m) => m.id === modelId);
        const previousIsEnabled = previousModel?.isEnabled;
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
          if (previousIsEnabled !== undefined) {
            set((state) => ({
              models: state.models.map((m) =>
                m.id === modelId ? { ...m, isEnabled: previousIsEnabled } : m
              ),
            }));
          }
          void get().fetchRegistry(db);
          throw error;
        }
      },

      toggleProvider: async (db: ModelRegistrySource, providerId: string, enabled: boolean) => {
        if (isCatalogCapability(db)) {
          set(registrySnapshot(await db.setProvider(providerId, enabled)));
          return;
        }

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
    clearPersistedStorageForTests(useModelRegistryStore);
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
  }
}
