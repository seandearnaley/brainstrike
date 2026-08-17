/**
 * Self-improvement signal preference (BST-1241).
 *
 * `enabled` is an explicit opt-in. It defaults OFF and is persisted. The
 * desktop assistant server owns telemetry querying and prompt injection; this
 * store only carries the renderer preference.
 *
 * Factory reset clears the persisted slice through `localStorage.clear()` and
 * resets the live store explicitly so an enabled signal cannot survive a reset
 * without a renderer reload (FACTORY RESET CONTRACT).
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

interface SelfImprovementSignalPreferencesData {
  /** Opt-in switch for telemetry signal injection. Defaults OFF. PERSISTED. */
  enabled: boolean;
}

interface SelfImprovementSignalPreferencesActions {
  resetToDefaults: () => void;
  setEnabled: (enabled: boolean) => void;
}

export type SelfImprovementSignalPreferencesStore = SelfImprovementSignalPreferencesData &
  SelfImprovementSignalPreferencesActions;

const STORE_NAME = 'self-improvement-signal-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultData(): SelfImprovementSignalPreferencesData {
  return { enabled: false };
}

function sanitizePersistedData(persistedState: unknown): SelfImprovementSignalPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = persistedState as Partial<SelfImprovementSignalPreferencesData>;
  return { enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : false };
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useSelfImprovementSignalPreferencesStore =
  create<SelfImprovementSignalPreferencesStore>()(
    persist(
      (set) => ({
        ...defaultData(),
        resetToDefaults: () => set(defaultData()),
        setEnabled: (enabled) => set({ enabled }),
      }),
      {
        merge: createSanitizedPersistMerge(sanitizePersistedData),
        migrate: sanitizePersistedData,
        name: STORE_NAME,
        partialize: (state) => ({ enabled: state.enabled }),
        storage,
        version: STORE_VERSION,
      }
    )
  );

export const selfImprovementSignalPreferencesSelectors = {
  enabled: (store: SelfImprovementSignalPreferencesStore): boolean => store.enabled,
};

/** Reset the live store and clear its persisted slice for factory reset. */
export function resetSelfImprovementSignalPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useSelfImprovementSignalPreferencesStore as typeof useSelfImprovementSignalPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useSelfImprovementSignalPreferencesStore.setState(defaultData());
}

/** Test-only reset helper. */
export function __resetSelfImprovementSignalPreferencesStoreForTests(): void {
  resetSelfImprovementSignalPreferencesStoreToDefaults();
}
