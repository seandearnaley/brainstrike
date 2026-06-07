import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

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
  reset: () => void;
  setEnabled: (enabled: boolean) => void;
  setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) => void;
  setManagedCollectionId: (managedCollectionId: string | null) => void;
  setPaused: (paused: boolean) => void;
}

export type BackgroundIndexingPreferencesStore = BackgroundIndexingPreferencesData &
  BackgroundIndexingPreferencesActions;

const STORE_NAME = 'background-indexing-preferences.v1' as const;

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

  return createBrowserJsonStorage();
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

export const useBackgroundIndexingPreferencesStore = create<BackgroundIndexingPreferencesStore>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,
      setEnabled: (enabled: boolean) => set({ enabled }),
      setIndexingPolicyPreset: (indexingPolicyPreset: BackgroundIndexingPolicyPreset) =>
        set({ indexingPolicyPreset }),
      setManagedCollectionId: (managedCollectionId: string | null) => set({ managedCollectionId }),
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
      version: 3,
      storage,
      partialize: (state: BackgroundIndexingPreferencesStore) => ({
        enabled: state.enabled,
        indexingPolicyPreset: state.indexingPolicyPreset,
        managedCollectionId: state.managedCollectionId,
        mode: state.mode,
        paused: state.paused,
      }),
      migrate: (persistedState: unknown) => {
        if (!(persistedState && typeof persistedState === 'object')) {
          return {
            ...DEFAULT_STATE,
          };
        }

        const candidate = persistedState as Partial<BackgroundIndexingPreferencesData>;
        return {
          enabled: candidate.enabled ?? DEFAULT_STATE.enabled,
          hasHydrated: false,
          indexingPolicyPreset:
            candidate.indexingPolicyPreset ?? DEFAULT_STATE.indexingPolicyPreset,
          managedCollectionId: candidate.managedCollectionId ?? DEFAULT_STATE.managedCollectionId,
          mode: candidate.mode ?? DEFAULT_STATE.mode,
          paused: candidate.paused ?? DEFAULT_STATE.paused,
        } satisfies BackgroundIndexingPreferencesData;
      },
      onRehydrateStorage: () => (_state, error) => {
        if (!error) {
          useBackgroundIndexingPreferencesStore.setState({ hasHydrated: true });
        }
      },
    }
  )
);

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
