import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown>
    ? T[K]
    : T[K] extends Array<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

interface LoggingPreferencesState {
  preferences: LoggingPreferences;
  hasHydrated: boolean;
  setPreferences: (preferences: LoggingPreferences) => void;
  updatePreferences: (updates: DeepPartial<LoggingPreferences>) => void;
  resetPreferences: () => void;
  markHydrated: () => void;
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

const memory = new Map<string, string>();

const storage = createJSONStorage(() => ({
  getItem: (key: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch {}
    return memory.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
        return;
      }
    } catch {}
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
        return;
      }
    } catch {}
    memory.delete(key);
  },
}));

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
  } catch {}
}
