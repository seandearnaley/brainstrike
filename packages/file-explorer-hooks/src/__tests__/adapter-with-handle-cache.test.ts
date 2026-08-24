import { describe, expect, it, vi } from 'vitest';
import { readHandleCache } from '../adapter-with-handle-cache.js';

interface CacheShape {
  read: () => void;
}

function isCacheShape(value: unknown): value is CacheShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as Record<string, unknown>)['read'] === 'function';
}

describe('readHandleCache', () => {
  it('returns null when the adapter capability is absent', () => {
    expect(readHandleCache({}, isCacheShape)).toBeNull();
  });

  it('returns a cache only after the caller validator proves its shape', () => {
    const cache: CacheShape = { read: vi.fn() };

    expect(readHandleCache({ getHandleCache: () => cache }, isCacheShape)).toBe(cache);
  });

  it('fails visibly when a present capability returns the wrong cache shape', () => {
    expect(() =>
      readHandleCache({ getHandleCache: () => ({ write: vi.fn() }) }, isCacheShape)
    ).toThrow('Adapter getHandleCache() returned an unsupported cache shape.');
  });
});
