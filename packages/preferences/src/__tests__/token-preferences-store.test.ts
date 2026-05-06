import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenPreferencesStoreForTests,
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '../stores/token-preferences-store';

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

const storeWithPersist = useTokenPreferencesStore as PersistApi<typeof useTokenPreferencesStore>;

describe('token-preferences-store', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    vi.restoreAllMocks();
  });

  it('initializes with accurate counting enabled', () => {
    const snapshot = useTokenPreferencesStore.getState();
    expect(snapshot.accurateCounting).toBe(true);
  });

  it('updates accurate counting flag via setter', () => {
    const storeState = useTokenPreferencesStore.getState();
    storeState.setAccurateCounting(false);
    const next = useTokenPreferencesStore.getState();
    expect(next.accurateCounting).toBe(false);
    expect(tokenPreferencesSelectors.accurateCounting(next)).toBe(false);
  });

  it('does not persist the default accurate counting state', () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    useTokenPreferencesStore.getState().setAccurateCounting(false);
    expect(options.storage.getItem(options.name)).not.toBeNull();

    useTokenPreferencesStore.getState().setAccurateCounting(true);
    expect(options.storage.getItem(options.name)).toBeNull();
  });

  it('persists state even when localStorage is unavailable', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const snapshot = useTokenPreferencesStore.getState();
    snapshot.setAccurateCounting(false);

    const persisted = storage.getItem(options.name);
    expect(persisted).not.toBeNull();

    if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
      throw new Error('expected persisted snapshot');
    }

    const persistedSnapshot = persisted as {
      state?: {
        accurateCounting?: boolean;
      };
    };

    expect(persistedSnapshot.state?.accurateCounting).toBe(false);

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name);
    expect(afterClear).toBeNull();
  });

  it('clears malformed persisted JSON before hydration', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    window.localStorage.setItem(options.name, '{not-valid-json');

    expect(options.storage.getItem(options.name)).toBeNull();
    expect(window.localStorage.getItem(options.name)).toBeNull();
  });
});
