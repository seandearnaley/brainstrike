import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSafeJsonStorageAdapter,
  createSafeStorage,
  createSafeStorageAdapter,
  type StorageError,
} from '../safe-storage';

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

describe('safe-storage', () => {
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
