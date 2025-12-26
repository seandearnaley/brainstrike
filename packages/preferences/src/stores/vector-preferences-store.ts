import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type DevicePref = 'webgpu' | 'wasm';

type VectorPreferencesData = {
  devicePref: DevicePref;
  reinitEveryN: number;
  verboseOrtLogs: boolean;
};

type VectorPreferencesActions = {
  setDevicePref: (v: DevicePref) => void;
  setReinitEveryN: (n: number) => void;
  setVerboseOrtLogs: (v: boolean) => void;
};

export type VectorPreferencesStore = VectorPreferencesData & VectorPreferencesActions;

const STORE_NAME = 'vector-preferences.v1' as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

export const useVectorPreferencesStore = create<VectorPreferencesStore>()(
  persist(
    (set) => ({
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
      setDevicePref: (v) => set({ devicePref: v }),
      setReinitEveryN: (n) => set({ reinitEveryN: Math.max(1, Math.floor(n)) }),
      setVerboseOrtLogs: (v) => set({ verboseOrtLogs: !!v }),
    }),
    {
      name: STORE_NAME,
      version: 2,
      storage,
      partialize: (s) => ({
        devicePref: s.devicePref,
        reinitEveryN: s.reinitEveryN,
        verboseOrtLogs: s.verboseOrtLogs,
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return;
        }
        if (version >= 2) {
          return persistedState as Partial<VectorPreferencesStore>;
        }
        const state = persistedState as Partial<VectorPreferencesStore> & {
          devicePref?: string | null;
        };
        const nextDevicePref = state.devicePref === 'wasm' ? 'wasm' : ('webgpu' as DevicePref);
        return {
          devicePref: nextDevicePref,
          reinitEveryN: state.reinitEveryN ?? 200,
          verboseOrtLogs: state.verboseOrtLogs ?? false,
        } satisfies Partial<VectorPreferencesStore>;
      },
    }
  )
);
