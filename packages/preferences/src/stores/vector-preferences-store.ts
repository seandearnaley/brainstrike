import { createSafeJsonStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type DevicePref = 'webgpu' | 'wasm';

interface VectorPreferencesData {
  devicePref: DevicePref;
  devicePrefConfigured: boolean;
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

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useVectorPreferencesStore = create<VectorPreferencesStore>()(
  persist(
    (set) => ({
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
      setDetectedDevicePref: (v) => set({ devicePref: v, devicePrefConfigured: false }),
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
      migrate: (persistedState, version) => {
        if (!persistedState) {
          return;
        }
        if (version >= 3) {
          return persistedState as Partial<VectorPreferencesStore>;
        }
        const state = persistedState as Partial<VectorPreferencesStore> & {
          devicePrefConfigured?: boolean | null;
          devicePref?: string | null;
        };
        const nextDevicePref = state.devicePref === 'wasm' ? 'wasm' : ('webgpu' as DevicePref);
        return {
          devicePrefConfigured: state.devicePrefConfigured === true,
          devicePref: nextDevicePref,
          reinitEveryN: state.reinitEveryN ?? 200,
          verboseOrtLogs: state.verboseOrtLogs ?? false,
        } satisfies Partial<VectorPreferencesStore>;
      },
    }
  )
);
