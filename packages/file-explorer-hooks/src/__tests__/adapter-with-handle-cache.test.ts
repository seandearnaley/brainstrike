import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUnsupportedHandleCacheReportForTests,
  readHandleCache,
} from '../adapter-with-handle-cache.js';

const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ error: loggerErrorMock }),
}));

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
  beforeEach(() => {
    loggerErrorMock.mockReset();
    __resetUnsupportedHandleCacheReportForTests();
  });

  it('returns null when the adapter capability is absent', () => {
    expect(readHandleCache({}, isCacheShape)).toBeNull();
  });

  it('returns a cache only after the caller validator proves its shape', () => {
    const cache: CacheShape = { read: vi.fn() };

    expect(readHandleCache({ getHandleCache: () => cache }, isCacheShape)).toBe(cache);
  });

  it('reports a persistent wrong cache shape only once across repeated probes', () => {
    const adapter = { getHandleCache: () => ({ write: vi.fn() }) };

    expect(readHandleCache(adapter, isCacheShape)).toBeNull();
    expect(readHandleCache(adapter, isCacheShape)).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Adapter getHandleCache() returned an unsupported cache shape; cache disabled.'
    );
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
