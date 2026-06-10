import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserJsonStorage, type PersistenceIssue } from '../stores/browser-json-storage';

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
