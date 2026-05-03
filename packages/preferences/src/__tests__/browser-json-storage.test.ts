import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserJsonStorage } from '../stores/browser-json-storage';

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
});
