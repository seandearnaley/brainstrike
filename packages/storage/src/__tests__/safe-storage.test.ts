import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserJsonStorage,
  createSafeJsonStateStorage,
  createSafeJsonStorageAdapter,
  createSafeStorage,
  createSafeStorageAdapter,
  type PersistenceIssue,
  type StorageError,
} from '../safe-storage';

const KEY = 'safe-storage.test';

function createWorkingStorage(initialEntries: [string, string][] = []): Storage {
  const values = new Map<string, string>(initialEntries);

  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() {
      return values.size;
    },
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function createThrowingStorage(error: Error): Storage {
  return {
    clear: vi.fn(() => {
      throw error;
    }),
    getItem: vi.fn(() => {
      throw error;
    }),
    key: vi.fn(() => {
      throw error;
    }),
    get length(): number {
      throw error;
    },
    removeItem: vi.fn(() => {
      throw error;
    }),
    setItem: vi.fn(() => {
      throw error;
    }),
  };
}

describe('createSafeStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('delegates to localStorage when browser storage is available', () => {
    const localStorage = createWorkingStorage([['first', 'one']]);
    vi.stubGlobal('localStorage', localStorage);
    const storage = createSafeStorage();

    expect(storage.getItem('first')).toBe('one');

    storage.setItem('second', 'two');
    expect(storage.getItem('second')).toBe('two');
    expect(storage.length).toBe(2);
    expect(storage.key(1)).toBe('second');

    storage.removeItem('first');
    expect(storage.getItem('first')).toBeNull();

    storage.clear();
    expect(storage.length).toBe(0);
  });

  it('falls back to in-memory storage and reports failed operations', () => {
    const storageError = new Error('storage unavailable');
    const localStorage = createThrowingStorage(storageError);
    const errors: StorageError[] = [];
    vi.stubGlobal('localStorage', localStorage);

    const storage = createSafeStorage((error) => errors.push(error));

    storage.setItem('token', 'abc');
    expect(storage.getItem('token')).toBe('abc');
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe('token');

    storage.removeItem('token');
    expect(storage.getItem('token')).toBeNull();

    storage.setItem('another', 'value');
    storage.clear();
    expect(storage.length).toBe(0);

    expect(errors.map((error) => error.operation)).toEqual([
      'set',
      'get',
      'key',
      'remove',
      'get',
      'set',
      'clear',
    ]);
    expect(errors.every((error) => error.error === storageError)).toBe(true);
  });

  it('creates a minimal storage adapter over the safe storage implementation', () => {
    const localStorage = createWorkingStorage();
    vi.stubGlobal('localStorage', localStorage);

    const adapter = createSafeStorageAdapter();

    adapter.setItem('panel-state', 'open');
    expect(adapter.getItem('panel-state')).toBe('open');

    adapter.removeItem('panel-state');
    expect(adapter.getItem('panel-state')).toBeNull();
  });
});

describe('createSafeJsonStorageAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clears corrupt JSON entries without crashing hydration', () => {
    const localStorage = createWorkingStorage([
      ['valid', JSON.stringify({ theme: 'dark' })],
      ['invalid', '{not json'],
    ]);
    const errors: StorageError[] = [];
    vi.stubGlobal('localStorage', localStorage);

    const adapter = createSafeJsonStorageAdapter({ errorHandler: (error) => errors.push(error) });

    expect(adapter.getItem('valid')).toBe('{"theme":"dark"}');
    expect(adapter.getItem('invalid')).toBeNull();
    expect(adapter.getItem('invalid')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ key: 'invalid', operation: 'get' });
  });
});

describe('createSafeJsonStateStorage', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  });

  it('round-trips valid JSON through localStorage', () => {
    const storage = createSafeJsonStateStorage({ scope: 'test' });
    storage.setItem(KEY, JSON.stringify({ hello: 'world' }));
    expect(storage.getItem(KEY)).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('returns null for missing keys', () => {
    const storage = createSafeJsonStateStorage({ scope: 'test' });
    expect(storage.getItem('does-not-exist')).toBeNull();
  });

  it('self-heals corrupted localStorage entries on read', () => {
    localStorage.setItem(KEY, '{not valid json');
    const storage = createSafeJsonStateStorage({ scope: 'test' });
    expect(storage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('falls back to migrateOnGet when localStorage is empty', () => {
    const migrated = JSON.stringify({ migrated: true });
    const storage = createSafeJsonStateStorage({
      migrateOnGet: () => migrated,
      scope: 'test',
    });
    expect(storage.getItem(KEY)).toBe(migrated);
  });

  it('persists a valid migrateOnGet result to the current key', () => {
    const migrated = JSON.stringify({ migrated: true });
    const storage = createSafeJsonStateStorage({
      migrateOnGet: () => migrated,
      scope: 'test',
    });
    expect(storage.getItem(KEY)).toBe(migrated);
    expect(localStorage.getItem(KEY)).toBe(migrated);
  });

  it('does NOT fall through to migrateOnGet when the current key was corrupted', () => {
    localStorage.setItem(KEY, '{not valid json');
    const migrated = JSON.stringify({ migrated: 'should-not-surface' });
    const storage = createSafeJsonStateStorage({
      migrateOnGet: () => migrated,
      scope: 'test',
    });
    expect(storage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drops a migrateOnGet result that is not valid JSON', () => {
    const storage = createSafeJsonStateStorage({
      migrateOnGet: () => 'not-json',
      scope: 'test',
    });
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('falls back to in-memory storage when localStorage rejects writes', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function failingSetItem() {
      throw new Error('QuotaExceededError');
    };
    try {
      const storage = createSafeJsonStateStorage({ scope: 'test' });
      const value = JSON.stringify({ in: 'memory' });
      storage.setItem(KEY, value);
      expect(storage.getItem(KEY)).toBe(value);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('removeItem clears both localStorage and the in-memory map', () => {
    const storage = createSafeJsonStateStorage({ scope: 'test' });
    storage.setItem(KEY, JSON.stringify({ a: 1 }));
    storage.removeItem(KEY);
    expect(storage.getItem(KEY)).toBeNull();
  });
});

describe('createBrowserJsonStorage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('returns valid JSON from localStorage', () => {
    const storage = createBrowserJsonStorage();
    window.localStorage.setItem('prefs', '{"enabled":true}');

    expect(storage.getItem('prefs')).toBe('{"enabled":true}');
  });

  it('clears malformed JSON instead of returning it', () => {
    const storage = createBrowserJsonStorage();
    window.localStorage.setItem('prefs', '{not-valid-json');

    expect(storage.getItem('prefs')).toBeNull();
    expect(window.localStorage.getItem('prefs')).toBeNull();
  });

  it('keeps cleanup best-effort when storage remove is blocked', () => {
    const storage = createBrowserJsonStorage();

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });

    storage.setItem('prefs', '{"enabled":true}');
    expect(storage.getItem('prefs')).toBe('{"enabled":true}');

    expect(() => storage.removeItem('prefs')).not.toThrow();
    expect(storage.getItem('prefs')).toBeNull();
  });

  it('surfaces localStorage write failures to callers without losing the session value', () => {
    const issues: PersistenceIssue[] = [];
    const storage = createBrowserJsonStorage({
      onPersistenceIssue: (issue) => issues.push(issue),
    });
    const blocked = new Error('blocked storage');

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw blocked;
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => null);

    storage.setItem('prefs', '{"enabled":true}');

    expect(storage.getItem('prefs')).toBe('{"enabled":true}');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      error: blocked,
      key: 'prefs',
      mode: 'memory',
      operation: 'set',
      storageArea: 'localStorage',
    });
  });

  it('isolates throwing persistence listeners before using the in-memory write path', () => {
    const storage = createBrowserJsonStorage({
      onPersistenceIssue: () => {
        throw new Error('listener failed');
      },
    });

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => null);

    expect(() => storage.setItem('prefs', '{"enabled":true}')).not.toThrow();
    expect(storage.getItem('prefs')).toBe('{"enabled":true}');
  });

  it('reports blocked persistent removes without claiming memory-only mode', () => {
    const issues: PersistenceIssue[] = [];
    const storage = createBrowserJsonStorage({
      onPersistenceIssue: (issue) => issues.push(issue),
    });
    const blocked = new Error('blocked remove');

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw blocked;
    });

    storage.removeItem('prefs');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      error: blocked,
      key: 'prefs',
      mode: 'persistent',
      operation: 'remove',
      storageArea: 'localStorage',
    });
  });
});
