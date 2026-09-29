import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';
import { VECTOR_PREFERENCES_STORE_NAME } from './vector-preferences-store-name';

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

const STORE_NAME = VECTOR_PREFERENCES_STORE_NAME;
const AUTOMATIC_WASM_DETECTION_ERROR =
  'Automatic vector device detection cannot persist WASM. Configure WASM explicitly if you need the slow/debug backend.';

export { VECTOR_PREFERENCES_STORE_NAME } from './vector-preferences-store-name';
export const VECTOR_PREFERENCES_CAPABILITY_ERROR =
  'This desktop renderer exposes no vector preferences capability. The visible UI reads electronAPI.storage and hidden hosts read electronAPI.vectorPreferences; with neither present the canonical device preference cannot be resolved.';

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

/**
 * The scoped capability hidden hosts receive instead of the unrestricted
 * key-value bridge (BST-1380). It carries no key: desktop main pins the
 * canonical record server-side, so a hidden renderer can neither enumerate nor
 * address any other persisted store.
 */
export interface ElectronVectorPreferencesBridge {
  readonly clear: () => Promise<void>;
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
}

interface VectorPreferencesCapabilities {
  readonly scoped?: ElectronVectorPreferencesBridge;
  readonly storage?: ElectronStorageBridge;
}

/**
 * Returns null when there is no Electron bridge at all (web/SSR/tests), and an
 * empty capability set when a desktop renderer exposes `electronAPI` without
 * either preference capability. Those two cases are NOT interchangeable: the
 * first legitimately uses browser storage, the second is a packaging fault that
 * must fail visibly rather than degrade to a private per-host copy.
 */
function getVectorPreferencesCapabilities(): VectorPreferencesCapabilities | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const electronAPI = (
    window as Window & {
      electronAPI?: {
        storage?: ElectronStorageBridge;
        vectorPreferences?: ElectronVectorPreferencesBridge;
      };
    }
  ).electronAPI;

  if (!electronAPI) {
    return null;
  }

  return {
    ...(electronAPI.vectorPreferences ? { scoped: electronAPI.vectorPreferences } : {}),
    ...(electronAPI.storage ? { storage: electronAPI.storage } : {}),
  };
}

function assertVectorPreferencesKey(key: string): void {
  if (key !== STORE_NAME) {
    throw new Error(
      `The scoped vector preferences capability serves only ${STORE_NAME}; received ${key}.`
    );
  }
}

function createScopedVectorPreferencesStorage(
  bridge: ElectronVectorPreferencesBridge
): StateStorage {
  return {
    getItem: (key: string) => {
      assertVectorPreferencesKey(key);
      return bridge.read();
    },
    removeItem: (key: string) => {
      assertVectorPreferencesKey(key);
      return bridge.clear();
    },
    setItem: (key: string, value: string) => {
      assertVectorPreferencesKey(key);
      return bridge.write(value);
    },
  };
}

/**
 * Throws when this renderer is an Electron renderer that received neither
 * preference capability. Web/SSR (no `electronAPI`) is unaffected.
 */
export function assertVectorPreferencesCapability(): void {
  const capabilities = getVectorPreferencesCapabilities();
  if (capabilities && !(capabilities.storage || capabilities.scoped)) {
    throw new Error(VECTOR_PREFERENCES_CAPABILITY_ERROR);
  }
}

function createVectorPreferencesStorage(): StateStorage {
  const capabilities = getVectorPreferencesCapabilities();

  if (!capabilities) {
    return createBrowserJsonStorage();
  }

  const electronStorage = capabilities.storage;
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }

  if (capabilities.scoped) {
    return createScopedVectorPreferencesStorage(capabilities.scoped);
  }

  throw new Error(VECTOR_PREFERENCES_CAPABILITY_ERROR);
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
    reinitEveryN:
      typeof persistedState.reinitEveryN === 'number' &&
      Number.isFinite(persistedState.reinitEveryN) &&
      persistedState.reinitEveryN > 0
        ? Math.floor(persistedState.reinitEveryN)
        : 200,
    verboseOrtLogs:
      typeof persistedState.verboseOrtLogs === 'boolean' ? persistedState.verboseOrtLogs : false,
  };
}

type PersistedVectorPreferencesData = Pick<
  VectorPreferencesData,
  'devicePref' | 'devicePrefConfigured' | 'reinitEveryN' | 'verboseOrtLogs'
>;

function sanitizePersistedData(persistedState: unknown): PersistedVectorPreferencesData {
  const state =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<VectorPreferencesStore> & {
          devicePrefConfigured?: boolean | null;
          devicePref?: string | null;
        })
      : {};
  return normalizePersistedVectorPreferences(state) as PersistedVectorPreferencesData;
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

function createDeferredVectorPreferencesStorage(): StateStorage {
  let lazyStorage: StateStorage | undefined;
  let lazyStoragePromise: Promise<StateStorage> | undefined;
  const resolveStorage = (): Promise<StateStorage> => {
    lazyStoragePromise ??= Promise.resolve()
      .then(createVectorPreferencesStorage)
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

/**
 * Desktop renderers must share preferences through the Electron storage bridge so
 * hidden hosts observe the same canonical settings as the visible UI.
 * Web/SSR/tests continue to use the safe browser storage adapter.
 */
const storage = createJSONStorage(createDeferredVectorPreferencesStorage);

/**
 * The last rehydration failure, or null. Zustand's persist middleware catches
 * storage rejections and resolves `rehydrate()` anyway, so this is the ONLY
 * signal that a read failed: after a failed reload the store keeps whatever it
 * hydrated previously, and its own `hasHydrated` field stays stale-`true`.
 * Without this, a broken capability presents as fresh preferences.
 *
 * Deliberately a plain module-scoped binding, written only from
 * `onRehydrateStorage`. That callback runs DURING `create(...)` for synchronous
 * storage, while `useVectorPreferencesStore` is still in its temporal dead
 * zone, so it must never touch the store binding — zustand swallows the
 * resulting ReferenceError and the logic silently never runs.
 */
let lastRehydrationError: Error | null = null;

function toRehydrationError(error: unknown): Error | null {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error : new Error(String(error));
}

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
      merge: createSanitizedPersistMerge<VectorPreferencesStore, PersistedVectorPreferencesData>(
        sanitizePersistedData
      ),
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
        return sanitizePersistedData(state);
      },
      name: STORE_NAME,
      // Runs at the START of every hydrate() (clearing any previous failure),
      // and the returned callback runs on settle with the error, if any.
      onRehydrateStorage: () => {
        lastRehydrationError = null;
        return (_state, error) => {
          lastRehydrationError = toRehydrationError(error);
        };
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

  // Zustand's persist middleware CATCHES storage rejections and resolves
  // `rehydrate()` anyway, leaving the store on its defaults. A missing
  // capability would therefore read as "unconfigured, use WebGPU" instead of
  // failing (BST-1380), so assert it here — this is the one entry point the
  // hidden embedding host resolves its device preference through.
  assertVectorPreferencesCapability();

  const forceReload = options?.forceReload ?? false;

  if (forceReload || !hasHydrated() || !useVectorPreferencesStore.getState().hasHydrated) {
    await rehydrate();

    // A rejected read leaves the store on whatever it hydrated before, with its
    // own `hasHydrated` field still stale-`true` — so the guards below would
    // accept it and the caller would receive stale preferences as if fresh.
    // Surface the underlying failure instead.
    if (lastRehydrationError) {
      throw lastRehydrationError;
    }
  }

  if (hasHydrated() && !useVectorPreferencesStore.getState().hasHydrated) {
    useVectorPreferencesStore.setState({ hasHydrated: true });
  }

  if (!(hasHydrated() || useVectorPreferencesStore.getState().hasHydrated)) {
    throw new Error('Vector preferences store failed to hydrate.');
  }

  return useVectorPreferencesStore.getState();
}
