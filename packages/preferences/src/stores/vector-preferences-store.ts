import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type DevicePref = 'auto' | 'webgpu' | 'wasm' | 'cpu';

interface VectorPreferencesData {
  devicePref: DevicePref;
  reinitEveryN: number;
  forceCpuAfterFailures: number;
  verboseOrtLogs: boolean;
}

interface VectorPreferencesActions {
  setDevicePref: (v: DevicePref) => void;
  setReinitEveryN: (n: number) => void;
  setForceCpuAfterFailures: (n: number) => void;
  setVerboseOrtLogs: (v: boolean) => void;
}

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
      devicePref: 'auto',
      reinitEveryN: 200,
      forceCpuAfterFailures: 3,
      verboseOrtLogs: false,
      setDevicePref: (v) => set({ devicePref: v }),
      setReinitEveryN: (n) => set({ reinitEveryN: Math.max(1, Math.floor(n)) }),
      setForceCpuAfterFailures: (n) => set({ forceCpuAfterFailures: Math.max(0, Math.floor(n)) }),
      setVerboseOrtLogs: (v) => set({ verboseOrtLogs: !!v }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        devicePref: s.devicePref,
        reinitEveryN: s.reinitEveryN,
        forceCpuAfterFailures: s.forceCpuAfterFailures,
        verboseOrtLogs: s.verboseOrtLogs,
      }),
    }
  )
);
