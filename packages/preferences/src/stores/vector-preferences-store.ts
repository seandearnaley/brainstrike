import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

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
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }

  return createBrowserJsonStorage();
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
    devicePref: devicePrefConfigured ? parsedDevicePref : 'webgpu',
    devicePrefConfigured,
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
      devicePref: 'webgpu',
      devicePrefConfigured: false,
      hasHydrated: false,
      markHydrated: () => set({ hasHydrated: true }),
      reinitEveryN: 200,
      setDetectedDevicePref: (v) => {
        if (v === 'wasm') {
          throw new Error(AUTOMATIC_WASM_DETECTION_ERROR);
        }
        set({ devicePref: v, devicePrefConfigured: false });
      },
      setDevicePref: (v) => set({ devicePref: v, devicePrefConfigured: true }),
      setReinitEveryN: (n) => set({ reinitEveryN: Math.max(1, Math.floor(n)) }),
      setVerboseOrtLogs: (v) => set({ verboseOrtLogs: !!v }),
      verboseOrtLogs: false,
    }),
    {
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
      name: STORE_NAME,
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
        }
      },
      partialize: (s) => ({
        devicePref: s.devicePref,
        devicePrefConfigured: s.devicePrefConfigured,
        reinitEveryN: s.reinitEveryN,
        verboseOrtLogs: s.verboseOrtLogs,
      }),
      storage,
      version: 3,
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
