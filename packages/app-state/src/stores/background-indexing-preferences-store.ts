import {
  type NativeIndexMode,
  type NativeLocalSelection,
  validateNativeIndexMode,
  validateNativeLocalSelection,
} from '@brainstrike/indexing-contract/indexer-producer';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

export type BackgroundIndexingMode = 'root-folder-cache';
export type BackgroundIndexingRootKind = 'fsa' | 'legacy' | 'path' | 'snapshot' | 'worktree';

export function isBackgroundIndexingRootKind(value: unknown): value is BackgroundIndexingRootKind {
  return (
    value === 'fsa' ||
    value === 'legacy' ||
    value === 'path' ||
    value === 'snapshot' ||
    value === 'worktree'
  );
}

/**
 * [D8] A `kind: 'worktree'` root defaults to indexing OFF until the hash-reuse
 * cost is MEASURED with the BST-393 benchmark harness. Content-hash-addressed
 * chunks make re-indexing a worktree plausibly cheap, but "plausibly" is not a
 * measurement, and N parallel worktrees of one repo at the old cost is the
 * failure mode this guards against. Users can explicitly opt individual
 * managed worktree roots into indexing; see `packages/app-shell/src/
 * background-indexing/workspace-collection-sync-provider.tsx`.
 */
export function defaultBackgroundIndexingEnabled(rootKind: string | null): boolean {
  if (rootKind !== null && !isBackgroundIndexingRootKind(rootKind)) {
    throw new Error(`Unsupported persisted root kind: ${String(rootKind)}`);
  }
  return rootKind !== 'worktree';
}

export interface WorktreeRootIndexingState {
  readonly dbRootId: string;
  readonly indexed: boolean;
}

export interface WorktreeRootIndexingStateInput extends WorktreeRootIndexingState {
  readonly adapterRootId: string;
}

interface BackgroundIndexingPreferencesData {
  enabled: boolean;
  hasHydrated: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  mode: BackgroundIndexingMode;
  nativeIndexMode: NativeIndexMode | null;
  nativeLocalSelection: NativeLocalSelection | null;
  paused: boolean;
  worktreeRootIndexingByAdapterRootId: Record<string, WorktreeRootIndexingState>;
  worktreeRootIndexingOptInById: Record<string, true>;
}

interface BackgroundIndexingPreferencesActions {
  markHydrated: () => void;
  reset: () => void;
  setEnabled: (enabled: boolean) => void;
  setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) => void;
  setManagedCollectionId: (managedCollectionId: string | null) => void;
  setNativeIndexMode: (mode: NativeIndexMode) => void;
  setNativeLocalSelection: (selection: NativeLocalSelection | null) => void;
  setPaused: (paused: boolean) => void;
  setWorktreeRootIndexingEnabled: (rootId: string, enabled: boolean) => void;
  setWorktreeRootIndexingState: (roots: readonly WorktreeRootIndexingStateInput[]) => void;
}

export type BackgroundIndexingPreferencesStore = BackgroundIndexingPreferencesData &
  BackgroundIndexingPreferencesActions;

const STORE_NAME = 'background-indexing-preferences.v1' as const;
const STORE_VERSION = 6 as const;

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function getElectronStorageBridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const bridge = (
    window as Window & {
      electronAPI?: {
        storage?: ElectronStorageBridge;
      };
    }
  ).electronAPI?.storage;

  if (!bridge) {
    return null;
  }

  return bridge;
}

function createBackgroundIndexingPreferencesStorage(): StateStorage {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }

  return createBrowserJsonStorage();
}

function createDeferredBackgroundIndexingPreferencesStorage(): StateStorage {
  let lazyStorage: StateStorage | undefined;
  let lazyStoragePromise: Promise<StateStorage> | undefined;
  const resolveStorage = (): Promise<StateStorage> => {
    lazyStoragePromise ??= Promise.resolve()
      .then(createBackgroundIndexingPreferencesStorage)
      .then((resolvedStorage) => {
        lazyStorage = resolvedStorage;
        return resolvedStorage;
      })
      .catch((error: unknown) => {
        lazyStoragePromise = undefined;
        throw error;
      });
    return lazyStoragePromise;
  };

  return {
    getItem: (key: string) => {
      if (lazyStorage) {
        return lazyStorage.getItem(key);
      }
      return resolveStorage().then((resolved) => resolved.getItem(key));
    },
    removeItem: (key: string) => {
      if (lazyStorage) {
        return lazyStorage.removeItem(key);
      }
      return resolveStorage().then((resolved) => resolved.removeItem(key));
    },
    setItem: (key: string, value: string) => {
      if (lazyStorage) {
        return lazyStorage.setItem(key, value);
      }
      return resolveStorage().then((resolved) => resolved.setItem(key, value));
    },
  };
}

const storage = createJSONStorage(createDeferredBackgroundIndexingPreferencesStorage);

const DEFAULT_STATE: BackgroundIndexingPreferencesData = {
  enabled: true,
  hasHydrated: false,
  indexingPolicyPreset: 'balanced',
  managedCollectionId: null,
  mode: 'root-folder-cache',
  nativeIndexMode: null,
  nativeLocalSelection: null,
  paused: false,
  worktreeRootIndexingByAdapterRootId: {},
  worktreeRootIndexingOptInById: {},
};

type BoundBackgroundIndexingPreferencesStore = ReturnType<
  ReturnType<typeof create<BackgroundIndexingPreferencesStore>>
>;

interface BackgroundIndexingPreferencesPersistApi {
  readonly getOptions?: () => {
    readonly storage?: {
      readonly getItem: (
        key: string
      ) =>
        | null
        | { state?: unknown; version?: number }
        | Promise<null | { state?: unknown; version?: number }>;
    };
  };
  readonly hasHydrated?: () => boolean;
  readonly onFinishHydration?: (
    listener: (state: BackgroundIndexingPreferencesStore) => void
  ) => () => void;
  readonly rehydrate?: () => Promise<void>;
}

const GLOBAL_KEY = '__brainstrike_background_indexing_preferences_store__' as const;
const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 3 as const;

/** The bound store plus the HMR brand slot stamped onto it after creation. */
type BrandableStore = BoundBackgroundIndexingPreferencesStore & {
  [BRAND]?: typeof BRAND_VERSION;
};

function installBackgroundIndexingHydrationMarker(
  store: BoundBackgroundIndexingPreferencesStore
): void {
  const persistApi = (
    store as BoundBackgroundIndexingPreferencesStore & {
      persist?: BackgroundIndexingPreferencesPersistApi;
    }
  ).persist;

  persistApi?.onFinishHydration?.((state) => {
    if (!state.hasHydrated) {
      store.setState({ hasHydrated: true });
    }
  });

  if (persistApi?.hasHydrated?.() && !store.getState().hasHydrated) {
    store.setState({ hasHydrated: true });
  }
}

function migrateBackgroundIndexingPreferencesState(
  persistedState: unknown
): BackgroundIndexingPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return {
      ...DEFAULT_STATE,
    };
  }

  const candidate = persistedState as Partial<BackgroundIndexingPreferencesData>;
  const worktreeRootIndexingOptInById: Record<string, true> = {};
  if (
    candidate.worktreeRootIndexingOptInById &&
    typeof candidate.worktreeRootIndexingOptInById === 'object'
  ) {
    for (const [rootId, enabled] of Object.entries(candidate.worktreeRootIndexingOptInById)) {
      if (rootId.trim().length > 0 && enabled === true) {
        worktreeRootIndexingOptInById[rootId] = true;
      }
    }
  }
  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_STATE.enabled,
    hasHydrated: false,
    indexingPolicyPreset:
      candidate.indexingPolicyPreset === 'balanced' ||
      candidate.indexingPolicyPreset === 'full-root'
        ? candidate.indexingPolicyPreset
        : DEFAULT_STATE.indexingPolicyPreset,
    managedCollectionId:
      typeof candidate.managedCollectionId === 'string' || candidate.managedCollectionId === null
        ? candidate.managedCollectionId
        : DEFAULT_STATE.managedCollectionId,
    mode: candidate.mode === 'root-folder-cache' ? candidate.mode : DEFAULT_STATE.mode,
    nativeIndexMode: validateNativeIndexMode(candidate.nativeIndexMode),
    nativeLocalSelection:
      candidate.nativeLocalSelection === null || candidate.nativeLocalSelection === undefined
        ? null
        : validateNativeLocalSelection(candidate.nativeLocalSelection),
    paused: typeof candidate.paused === 'boolean' ? candidate.paused : DEFAULT_STATE.paused,
    worktreeRootIndexingByAdapterRootId: {},
    worktreeRootIndexingOptInById,
  };
}

const mergeBackgroundIndexingPreferences = createSanitizedPersistMerge<
  BackgroundIndexingPreferencesStore,
  BackgroundIndexingPreferencesData
>(migrateBackgroundIndexingPreferencesState);

async function readBackgroundIndexingPreferencesFromStorage(
  persistApi: BackgroundIndexingPreferencesPersistApi
): Promise<BackgroundIndexingPreferencesData> {
  const storageAdapter = persistApi.getOptions?.().storage;
  if (!storageAdapter) {
    throw new Error('Background indexing preferences storage adapter is unavailable.');
  }

  const storedValue = await storageAdapter.getItem(STORE_NAME);
  if (!storedValue) {
    return {
      ...DEFAULT_STATE,
    };
  }

  return migrateBackgroundIndexingPreferencesState(storedValue.state);
}

function createBackgroundIndexingPreferencesStore(): BoundBackgroundIndexingPreferencesStore {
  const store = create<BackgroundIndexingPreferencesStore>()(
    persist(
      (set, get) => ({
        ...DEFAULT_STATE,
        markHydrated: () => set({ hasHydrated: true }),
        reset: () =>
          set({
            enabled: DEFAULT_STATE.enabled,
            hasHydrated: true,
            indexingPolicyPreset: DEFAULT_STATE.indexingPolicyPreset,
            managedCollectionId: DEFAULT_STATE.managedCollectionId,
            mode: DEFAULT_STATE.mode,
            nativeIndexMode: DEFAULT_STATE.nativeIndexMode,
            nativeLocalSelection: DEFAULT_STATE.nativeLocalSelection,
            paused: DEFAULT_STATE.paused,
            worktreeRootIndexingByAdapterRootId: DEFAULT_STATE.worktreeRootIndexingByAdapterRootId,
            worktreeRootIndexingOptInById: DEFAULT_STATE.worktreeRootIndexingOptInById,
          }),
        setEnabled: (enabled: boolean) => set({ enabled }),
        setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) =>
          set({ indexingPolicyPreset }),
        setManagedCollectionId: (managedCollectionId: string | null) =>
          set({ managedCollectionId }),
        setNativeIndexMode: (nativeIndexMode: NativeIndexMode) => {
          if (nativeIndexMode !== 'TEXT' && nativeIndexMode !== 'VECTOR') {
            throw new Error('Native indexing requires explicit TEXT or VECTOR mode.');
          }
          set({ nativeIndexMode });
        },
        setNativeLocalSelection: (selection: NativeLocalSelection | null) =>
          set({
            nativeLocalSelection:
              selection === null ? null : validateNativeLocalSelection(selection),
          }),
        setPaused: (paused: boolean) => set({ paused }),
        setWorktreeRootIndexingEnabled: (rootId: string, enabled: boolean) => {
          if (rootId.trim().length === 0) {
            throw new Error('A worktree root id is required to change indexing.');
          }
          set((state) => {
            const worktreeRootIndexingOptInById = {
              ...state.worktreeRootIndexingOptInById,
            };
            if (enabled) {
              worktreeRootIndexingOptInById[rootId] = true;
            } else {
              delete worktreeRootIndexingOptInById[rootId];
            }
            return { worktreeRootIndexingOptInById };
          });
        },
        setWorktreeRootIndexingState: (roots: readonly WorktreeRootIndexingStateInput[]) => {
          const worktreeRootIndexingByAdapterRootId: Record<string, WorktreeRootIndexingState> = {};
          for (const root of roots) {
            worktreeRootIndexingByAdapterRootId[root.adapterRootId] = {
              dbRootId: root.dbRootId,
              indexed: root.indexed,
            };
          }
          const current = get().worktreeRootIndexingByAdapterRootId;
          const nextRootIds = Object.keys(worktreeRootIndexingByAdapterRootId);
          if (
            nextRootIds.length === Object.keys(current).length &&
            nextRootIds.every((rootId) => {
              const previous = current[rootId];
              const next = worktreeRootIndexingByAdapterRootId[rootId];
              return previous?.dbRootId === next?.dbRootId && previous?.indexed === next?.indexed;
            })
          ) {
            return;
          }
          set({ worktreeRootIndexingByAdapterRootId });
        },
      }),
      {
        merge: (persistedState, currentState) => ({
          ...mergeBackgroundIndexingPreferences(persistedState, currentState),
          worktreeRootIndexingByAdapterRootId: currentState.worktreeRootIndexingByAdapterRootId,
        }),
        migrate: (persistedState: unknown) =>
          migrateBackgroundIndexingPreferencesState(persistedState),
        name: STORE_NAME,
        partialize: (state: BackgroundIndexingPreferencesStore) => ({
          enabled: state.enabled,
          indexingPolicyPreset: state.indexingPolicyPreset,
          managedCollectionId: state.managedCollectionId,
          mode: state.mode,
          nativeIndexMode: state.nativeIndexMode,
          nativeLocalSelection: state.nativeLocalSelection,
          paused: state.paused,
          worktreeRootIndexingOptInById: state.worktreeRootIndexingOptInById,
        }),
        storage,
        version: STORE_VERSION,
      }
    )
  );
  installBackgroundIndexingHydrationMarker(store);
  // Widening to an optional brand slot is a plain assignment, so the brand can
  // be stamped without casting the bound store to an index-signature shape.
  const brandable: BrandableStore = store;
  brandable[BRAND] = BRAND_VERSION;
  return store;
}

function isValidStore(
  candidate: unknown
): candidate is BoundBackgroundIndexingPreferencesStore & Record<string, unknown> {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as {
    getState?: unknown;
    persist?: BackgroundIndexingPreferencesPersistApi;
    setState?: unknown;
    [BRAND]?: unknown;
  };
  return (
    typeof fn.getState === 'function' &&
    typeof fn.setState === 'function' &&
    typeof fn.persist?.hasHydrated === 'function' &&
    typeof fn.persist.rehydrate === 'function' &&
    fn[BRAND] === BRAND_VERSION
  );
}

// `typeof globalThis` carries an implicit string index signature, so the
// registry view is a plain annotated assignment — no cast required.
const globalStoreRegistry: Record<string, unknown> = globalThis;
const existingStore = globalStoreRegistry[GLOBAL_KEY];

export const useBackgroundIndexingPreferencesStore = isValidStore(existingStore)
  ? existingStore
  : createBackgroundIndexingPreferencesStore();

globalStoreRegistry[GLOBAL_KEY] = useBackgroundIndexingPreferencesStore;

export async function ensureBackgroundIndexingPreferencesHydrated(options?: {
  forceReload?: boolean;
}): Promise<BackgroundIndexingPreferencesStore> {
  const persistApi = (
    useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
      persist?: BackgroundIndexingPreferencesPersistApi;
    }
  ).persist;

  const hasHydrated = persistApi?.hasHydrated;
  const rehydrate = persistApi?.rehydrate;

  if (!persistApi || typeof hasHydrated !== 'function' || typeof rehydrate !== 'function') {
    throw new Error('Background indexing preferences persist API is unavailable.');
  }

  const forceReload = options?.forceReload ?? false;

  if (
    forceReload ||
    !hasHydrated() ||
    !useBackgroundIndexingPreferencesStore.getState().hasHydrated
  ) {
    await rehydrate();
  }

  if (!hasHydrated()) {
    const storageState = await readBackgroundIndexingPreferencesFromStorage(persistApi);
    const { worktreeRootIndexingByAdapterRootId } =
      useBackgroundIndexingPreferencesStore.getState();
    useBackgroundIndexingPreferencesStore.setState({
      ...storageState,
      hasHydrated: true,
      worktreeRootIndexingByAdapterRootId,
    });
  }

  if (hasHydrated() && !useBackgroundIndexingPreferencesStore.getState().hasHydrated) {
    useBackgroundIndexingPreferencesStore.setState({ hasHydrated: true });
  }

  if (!(hasHydrated() || useBackgroundIndexingPreferencesStore.getState().hasHydrated)) {
    throw new Error('Background indexing preferences store failed to hydrate.');
  }

  return useBackgroundIndexingPreferencesStore.getState();
}

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline so a stale per-root `worktreeRootIndexingOptInById`
 * entry never survives a reset without a reload (web path) (FACTORY RESET
 * CONTRACT).
 */
export function resetBackgroundIndexingPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useBackgroundIndexingPreferencesStore.getState().reset();
}

export function __resetBackgroundIndexingPreferencesStoreForTests(): void {
  try {
    useBackgroundIndexingPreferencesStore.setState({
      ...DEFAULT_STATE,
    });
    const persistApi = (
      useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    useBackgroundIndexingPreferencesStore.setState({
      ...DEFAULT_STATE,
    });
  }
}
