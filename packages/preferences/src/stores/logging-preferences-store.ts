import { LogLevel } from '@brainstrike/utils/logger';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
} from '@brainstrike/utils/logging-preferences';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

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
  level: LogLevel.INFO,
  consoleLevel: LogLevel.INFO,
  includeTimestamp: false,
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
      preferences: DEFAULT_PREFERENCES,
      hasHydrated: false,

      setPreferences: (preferences) => {
        set({ preferences, hasHydrated: true });
      },

      updatePreferences: (updates) => {
        const current = get().preferences;
        const merged = mergeLoggingPreferences(current, updates);
        set({ preferences: merged });
      },

      resetPreferences: () => {
        set({ preferences: DEFAULT_PREFERENCES, hasHydrated: true });
      },

      markHydrated: () => {
        set({ hasHydrated: true });
      },
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (state) => ({
        preferences: state.preferences,
      }),
      onRehydrateStorage: () => (_state, error) => {
        if (!error) {
          useLoggingPreferencesStore.setState({ hasHydrated: true });
        }
      },
    }
  )
);

export function __resetLoggingPreferencesStoreForTests() {
  try {
    useLoggingPreferencesStore.setState({
      preferences: DEFAULT_PREFERENCES,
      hasHydrated: false,
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
