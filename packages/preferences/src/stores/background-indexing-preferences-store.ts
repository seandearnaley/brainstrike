import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type BackgroundIndexingMode = 'root-folder-cache';

interface BackgroundIndexingPreferencesData {
  enabled: boolean;
  hasHydrated: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  mode: BackgroundIndexingMode;
  paused: boolean;
}

interface BackgroundIndexingPreferencesActions {
  markHydrated: () => void;
  reset: () => void;
  setEnabled: (enabled: boolean) => void;
  setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) => void;
  setManagedCollectionId: (managedCollectionId: string | null) => void;
  setPaused: (paused: boolean) => void;
}

export type BackgroundIndexingPreferencesStore = BackgroundIndexingPreferencesData &
  BackgroundIndexingPreferencesActions;

const STORE_NAME = 'background-indexing-preferences.v1' as const;
const STORE_VERSION = 4 as const;

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

function createBackgroundIndexingPreferencesStorage() {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }

  return createLocalBrowserJsonStorage();
}

function readBrowserLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return;
  }
}

function removeBrowserStoredValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A failed cleanup must not make the preference store non-persistent.
  }
}

function createLocalBrowserJsonStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const storage = readBrowserLocalStorage();
      let storedValue: string | null | undefined;
      try {
        storedValue = storage?.getItem(key);
      } catch {
        storedValue = undefined;
      }

      const raw = storedValue ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        removeBrowserStoredValue(storage, key);
        memory.delete(key);
        return null;
      }
    },
    removeItem: (key) => {
      removeBrowserStoredValue(readBrowserLocalStorage(), key);
      memory.delete(key);
    },
    setItem: (key, value) => {
      const storage = readBrowserLocalStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall through to memory for browsers that deny localStorage writes.
        }
      }
      memory.set(key, value);
    },
  };
}

const storage = createJSONStorage(() => createBackgroundIndexingPreferencesStorage());

const DEFAULT_STATE: BackgroundIndexingPreferencesData = {
  enabled: true,
  hasHydrated: false,
  indexingPolicyPreset: 'balanced',
  managedCollectionId: null,
  mode: 'root-folder-cache',
  paused: false,
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
const BRAND_VERSION = 1 as const;

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
  return {
    enabled: candidate.enabled ?? DEFAULT_STATE.enabled,
    hasHydrated: false,
    indexingPolicyPreset: candidate.indexingPolicyPreset ?? DEFAULT_STATE.indexingPolicyPreset,
    managedCollectionId: candidate.managedCollectionId ?? DEFAULT_STATE.managedCollectionId,
    mode: candidate.mode ?? DEFAULT_STATE.mode,
    paused: candidate.paused ?? DEFAULT_STATE.paused,
  };
}

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
      (set) => ({
        ...DEFAULT_STATE,
        setEnabled: (enabled: boolean) => set({ enabled }),
        setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) =>
          set({ indexingPolicyPreset }),
        markHydrated: () => set({ hasHydrated: true }),
        setManagedCollectionId: (managedCollectionId: string | null) =>
          set({ managedCollectionId }),
        setPaused: (paused: boolean) => set({ paused }),
        reset: () =>
          set({
            enabled: DEFAULT_STATE.enabled,
            indexingPolicyPreset: DEFAULT_STATE.indexingPolicyPreset,
            managedCollectionId: DEFAULT_STATE.managedCollectionId,
            mode: DEFAULT_STATE.mode,
            paused: DEFAULT_STATE.paused,
            hasHydrated: true,
          }),
      }),
      {
        name: STORE_NAME,
        version: STORE_VERSION,
        storage,
        partialize: (state: BackgroundIndexingPreferencesStore) => ({
          enabled: state.enabled,
          indexingPolicyPreset: state.indexingPolicyPreset,
          managedCollectionId: state.managedCollectionId,
          mode: state.mode,
          paused: state.paused,
        }),
        migrate: (persistedState: unknown) =>
          migrateBackgroundIndexingPreferencesState(persistedState),
        onRehydrateStorage: () => (_state, error) => {
          if (error) {
            return;
          }
        },
      }
    )
  );
  installBackgroundIndexingHydrationMarker(store);
  (store as unknown as Record<string, unknown>)[BRAND] = BRAND_VERSION;
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

const globalStoreRegistry = globalThis as unknown as Record<string, unknown>;
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
    useBackgroundIndexingPreferencesStore.setState({
      ...storageState,
      hasHydrated: true,
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
