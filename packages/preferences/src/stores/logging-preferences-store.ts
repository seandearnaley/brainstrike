import { createBrowserJsonStorage } from '@brainstrike/storage';
import { LogLevel } from '@brainstrike/utils/logger';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
} from '@brainstrike/utils/logging-preferences';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

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
      name: STORE_NAME,
      onRehydrateStorage: () => (_state, error) => {
        if (!error) {
          useLoggingPreferencesStore.setState({ hasHydrated: true });
        }
      },
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
    const persistApi = (
      useLoggingPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
