import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type DevicePref = 'webgpu' | 'wasm';

interface VectorPreferencesData {
  devicePref: DevicePref;
  devicePrefConfigured: boolean;
  hasHydrated: boolean;
  reinitEveryN: number;
  verboseOrtLogs: boolean;
}

interface VectorPreferencesActions {
  markHydrated: () => void;
  setDetectedDevicePref: (v: DevicePref) => void;
  setDevicePref: (v: DevicePref) => void;
  setReinitEveryN: (n: number) => void;
  setVerboseOrtLogs: (v: boolean) => void;
}

export type VectorPreferencesStore = VectorPreferencesData & VectorPreferencesActions;

const STORE_NAME = 'vector-preferences.v1' as const;
const AUTOMATIC_WASM_DETECTION_ERROR =
  'Automatic vector device detection cannot persist WASM. Configure WASM explicitly if you need the slow/debug backend.';

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

function createVectorPreferencesStorage() {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
      removeItem: (key: string) => electronStorage.removeItem(key),
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

function normalizePersistedVectorPreferences(
  persistedState: Partial<VectorPreferencesStore> & {
    devicePrefConfigured?: boolean | null;
    devicePref?: string | null;
  }
): Partial<VectorPreferencesStore> {
  const devicePrefConfigured = persistedState.devicePrefConfigured === true;
  const parsedDevicePref = persistedState.devicePref === 'wasm' ? 'wasm' : 'webgpu';
  return {
    devicePrefConfigured,
    devicePref: devicePrefConfigured ? parsedDevicePref : 'webgpu',
    reinitEveryN: persistedState.reinitEveryN ?? 200,
    verboseOrtLogs: persistedState.verboseOrtLogs ?? false,
  };
}

interface VectorPreferencesPersistApi {
  readonly hasHydrated?: () => boolean;
  readonly onFinishHydration?: (listener: (state: VectorPreferencesStore) => void) => () => void;
  readonly rehydrate?: () => Promise<void>;
}

type BoundVectorPreferencesStore = ReturnType<ReturnType<typeof create<VectorPreferencesStore>>>;

function installVectorPreferencesHydrationMarker(store: BoundVectorPreferencesStore): void {
  const persistApi = (
    store as BoundVectorPreferencesStore & {
      persist?: VectorPreferencesPersistApi;
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

/**
 * Desktop renderers must share preferences through the Electron storage bridge so
 * hidden hosts observe the same canonical settings as the visible UI.
 * Web/SSR/tests continue to use the safe browser storage adapter.
 */
const storage = createJSONStorage(() => createVectorPreferencesStorage());

export const useVectorPreferencesStore = create<VectorPreferencesStore>()(
  persist(
    (set) => ({
      hasHydrated: false,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
      markHydrated: () => set({ hasHydrated: true }),
      setDetectedDevicePref: (v) => {
        if (v === 'wasm') {
          throw new Error(AUTOMATIC_WASM_DETECTION_ERROR);
        }
        set({ devicePref: v, devicePrefConfigured: false });
      },
      setDevicePref: (v) => set({ devicePref: v, devicePrefConfigured: true }),
      setReinitEveryN: (n) => set({ reinitEveryN: Math.max(1, Math.floor(n)) }),
      setVerboseOrtLogs: (v) => set({ verboseOrtLogs: !!v }),
    }),
    {
      name: STORE_NAME,
      version: 3,
      storage,
      partialize: (s) => ({
        devicePrefConfigured: s.devicePrefConfigured,
        devicePref: s.devicePref,
        reinitEveryN: s.reinitEveryN,
        verboseOrtLogs: s.verboseOrtLogs,
      }),
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          return;
        }
      },
      migrate: (persistedState) => {
        if (!persistedState) {
          // Return explicit defaults so Zustand never sees undefined fields
          // during hydration — hooks read state.devicePref synchronously and
          // an undefined value would propagate to WebGPU initialization.
          return {
            devicePref: 'webgpu' as DevicePref,
            devicePrefConfigured: false,
            reinitEveryN: 200,
            verboseOrtLogs: false,
          } satisfies Partial<VectorPreferencesStore>;
        }
        const state = persistedState as Partial<VectorPreferencesStore> & {
          devicePrefConfigured?: boolean | null;
          devicePref?: string | null;
        };
        return normalizePersistedVectorPreferences(state);
      },
    }
  )
);

installVectorPreferencesHydrationMarker(useVectorPreferencesStore);

export async function ensureVectorPreferencesHydrated(options?: {
  forceReload?: boolean;
}): Promise<VectorPreferencesStore> {
  const persistApi = (
    useVectorPreferencesStore as typeof useVectorPreferencesStore & {
      persist?: VectorPreferencesPersistApi;
    }
  ).persist;

  const hasHydrated = persistApi?.hasHydrated;
  const rehydrate = persistApi?.rehydrate;

  if (typeof hasHydrated !== 'function' || typeof rehydrate !== 'function') {
    throw new Error('Vector preferences persist API is unavailable.');
  }

  const forceReload = options?.forceReload ?? false;

  if (forceReload || !hasHydrated() || !useVectorPreferencesStore.getState().hasHydrated) {
    await rehydrate();
  }

  if (hasHydrated() && !useVectorPreferencesStore.getState().hasHydrated) {
    useVectorPreferencesStore.setState({ hasHydrated: true });
  }

  if (!(hasHydrated() || useVectorPreferencesStore.getState().hasHydrated)) {
    throw new Error('Vector preferences store failed to hydrate.');
  }

  return useVectorPreferencesStore.getState();
}
