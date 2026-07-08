import { createDefaultLoggingPreferences, LogLevel } from '@brainstrike/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '../stores/logging-preferences-store';

type PersistApi<T> = T & {
  persist?: {
    getOptions?: () => {
      name: string;
      storage: {
        getItem: (name: string) => string | null;
        setItem: (name: string, value: string) => void;
        removeItem: (name: string) => void;
      };
    };
    clearStorage?: () => void;
  };
};

const storeWithPersist = useLoggingPreferencesStore as PersistApi<
  typeof useLoggingPreferencesStore
>;

describe('logging-preferences-store', () => {
  beforeEach(() => {
    __resetLoggingPreferencesStoreForTests();
    vi.restoreAllMocks();
  });

  it('sets and updates preferences while preserving nested defaults', () => {
    const store = useLoggingPreferencesStore.getState();
    expect(store.hasHydrated).toBe(false);

    const initial = createDefaultLoggingPreferences({
      consoleLevel: LogLevel.WARN,
      file: {
        append: true,
        destination: '/tmp/brain.log',
        enabled: true,
        level: LogLevel.ERROR,
        mkdir: true,
      },
      level: LogLevel.DEBUG,
    });

    store.setPreferences(initial);

    const afterSet = useLoggingPreferencesStore.getState();
    expect(afterSet.hasHydrated).toBe(true);
    expect(afterSet.preferences.file.destination).toBe('/tmp/brain.log');

    store.updatePreferences({
      file: { level: LogLevel.FATAL },
      includeTimestamp: true,
      redactPaths: ['/foo'],
    });

    const updated = useLoggingPreferencesStore.getState().preferences;
    expect(updated.includeTimestamp).toBe(true);
    expect(updated.file.enabled).toBe(true);
    expect(updated.file.level).toBe(LogLevel.FATAL);
    expect(updated.file.destination).toBe('/tmp/brain.log');
    expect(updated.redactPaths).toEqual(['/foo']);
  });

  it('resets preferences and marks hydration', () => {
    const store = useLoggingPreferencesStore.getState();
    store.markHydrated();
    expect(useLoggingPreferencesStore.getState().hasHydrated).toBe(true);

    store.resetPreferences();
    const next = useLoggingPreferencesStore.getState();
    expect(next.hasHydrated).toBe(true);
    expect(next.preferences).toEqual(
      createDefaultLoggingPreferences({
        consoleLevel: LogLevel.INFO,
        includeTimestamp: false,
        level: LogLevel.INFO,
      })
    );
  });

  it('uses in-memory persistence when localStorage is blocked and manages fallback storage', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('read only');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('read only');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('read only');
    });

    useLoggingPreferencesStore.getState().setPreferences(
      createDefaultLoggingPreferences({
        consoleLevel: LogLevel.WARN,
        level: LogLevel.DEBUG,
      })
    );

    const persistedValue = storage.getItem(options.name)!;
    expect(persistedValue).not.toBeNull();
    if (
      !persistedValue ||
      typeof (persistedValue as { state?: unknown }) !== 'object' ||
      Array.isArray(persistedValue)
    ) {
      throw new Error('unexpected persisted snapshot');
    }

    const snapshot = persistedValue as {
      state?: {
        preferences: ReturnType<typeof createDefaultLoggingPreferences>;
      };
    };
    expect(snapshot.state?.preferences.level).toBe(LogLevel.DEBUG);
    expect(snapshot.state?.preferences.consoleLevel).toBe(LogLevel.WARN);

    const keys: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const key = `temp-logging-${index}`;
      keys.push(key);
      storage.setItem(key, { state: { index }, version: 1 });
    }

    const latest = storage.getItem(keys.at(-1)!)!;
    expect(latest).not.toBeNull();

    const first = storage.getItem(keys[0]!);
    expect(first === null || typeof first === 'object').toBe(true);

    keys.forEach((key) => {
      storage.removeItem(key);
    });

    persistApi.clearStorage?.();
    expect(storage.getItem(options.name)!).toBeNull();
  });
});
