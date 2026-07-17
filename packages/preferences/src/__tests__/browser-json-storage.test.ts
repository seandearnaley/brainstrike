import { createBrowserJsonStorage, type PersistenceIssue } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Consumer-facing regression: preferences packages continue to get the
 * browser JSON storage contract from `@brainstrike/storage`.
 */
describe('createBrowserJsonStorage (preferences consumer)', () => {
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

  it('surfaces localStorage write failures without losing the session value', () => {
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
});
