import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { clearPersistedStorageForTests } from './persist-api';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends unknown[]
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

interface LoggingPreferencesState {
  hasHydrated: boolean;
  markHydrated: () => void;
  preferences: LoggingPreferences;
  resetPreferences: () => void;
  setPreferences: (preferences: LoggingPreferences) => void;
  updatePreferences: (updates: DeepPartial<LoggingPreferences>) => void;
}

const STORE_NAME = 'logging-preferences.v1' as const;

const DEFAULT_PREFERENCES = createDefaultLoggingPreferences({
  consoleLevel: LogLevel.INFO,
  includeTimestamp: false,
  level: LogLevel.INFO,
});

function mergeLoggingPreferences(
  current: LoggingPreferences,
  updates: DeepPartial<LoggingPreferences>
): LoggingPreferences {
  const next: LoggingPreferences = {
    ...current,
    ...updates,
    file: {
      ...current.file,
      ...(updates.file ?? {}),
    },
    redactPaths: updates.redactPaths ?? current.redactPaths,
  };

  return next;
}

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useLoggingPreferencesStore = create<LoggingPreferencesState>()(
  persist(
    (set, get) => ({
      hasHydrated: false,

      markHydrated: () => {
        set({ hasHydrated: true });
      },
      preferences: DEFAULT_PREFERENCES,

      resetPreferences: () => {
        set({ hasHydrated: true, preferences: DEFAULT_PREFERENCES });
      },

      setPreferences: (preferences) => {
        set({ hasHydrated: true, preferences });
      },

      updatePreferences: (updates) => {
        const current = get().preferences;
        const merged = mergeLoggingPreferences(current, updates);
        set({ preferences: merged });
      },
    }),
    {
      /**
       * BST-1645: `hasHydrated` is marked HERE, not in `onRehydrateStorage`.
       *
       * `createBrowserJsonStorage().getItem` is synchronous, so zustand's
       * persist middleware resolves hydration DURING `create(...)` — while the
       * module-level `useLoggingPreferencesStore` binding is still in its
       * temporal dead zone. The old rehydrate callback called
       * `useLoggingPreferencesStore.setState` and threw a ReferenceError that
       * zustand swallowed (it re-invokes the callback as `(undefined, error)`,
       * whose `if (!error)` guard then declines), so `hasHydrated` never became
       * true on the app's real hydration path. Same bug as #2086; see
       * `import-settings-store.ts`.
       *
       * `merge` needs no module binding and runs on every hydration, including
       * the version-matched case where `migrate` never runs. A storage read
       * that rejects skips `merge` entirely, so `hasHydrated` still stays false
       * on failure — the behaviour the old `if (!error)` guard intended.
       */
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<LoggingPreferencesState> | undefined),
        hasHydrated: true,
      }),
      name: STORE_NAME,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
      storage,
      version: 1,
    }
  )
);

export function __resetLoggingPreferencesStoreForTests() {
  try {
    useLoggingPreferencesStore.setState({
      hasHydrated: false,
      preferences: DEFAULT_PREFERENCES,
    });
    clearPersistedStorageForTests(useLoggingPreferencesStore);
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
