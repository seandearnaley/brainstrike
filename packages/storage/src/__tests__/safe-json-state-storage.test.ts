import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSafeJsonStateStorage } from '../safe-json-state-storage';

const KEY = 'safe-json-state-storage.test';

describe('createSafeJsonStateStorage', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  });

  afterEach(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
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
    // Simulate a partial-write or DevTools paste — bytes that aren't valid JSON.
    localStorage.setItem(KEY, '{not valid json');
    const storage = createSafeJsonStateStorage({ scope: 'test' });
    expect(storage.getItem(KEY)).toBeNull();
    // The corrupted entry should have been evicted so next reload starts clean.
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
    // If the user had data under the current key (even if it later got corrupted), we
    // should not silently restore legacy data on top of their cleared state — let the
    // store's defaults kick in. The corrupted entry has already been evicted, so a
    // subsequent reload will see "missing" and run the migration cleanly.
    localStorage.setItem(KEY, '{not valid json');
    const migrated = JSON.stringify({ migrated: 'should-not-surface' });
    const storage = createSafeJsonStateStorage({
      migrateOnGet: () => migrated,
      scope: 'test',
    });
    expect(storage.getItem(KEY)).toBeNull();
    // Current key was evicted by validateOrEvictJson
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
