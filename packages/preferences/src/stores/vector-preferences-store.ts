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
    devicePrefConfigured,
    devicePref: devicePrefConfigured ? parsedDevicePref : 'webgpu',
    reinitEveryN: persistedState.reinitEveryN ?? 200,
    verboseOrtLogs: persistedState.verboseOrtLogs ?? false,
  };
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
        if (!error) {
          useVectorPreferencesStore.setState({ hasHydrated: true });
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

interface VectorPreferencesPersistApi {
  readonly hasHydrated?: () => boolean;
  readonly rehydrate?: () => Promise<void>;
}

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

  if (!(hasHydrated() || useVectorPreferencesStore.getState().hasHydrated)) {
    throw new Error('Vector preferences store failed to hydrate.');
  }

  return useVectorPreferencesStore.getState();
}
