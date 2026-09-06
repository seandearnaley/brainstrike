import { createLogger } from '@brainstrike/logging';

const logger = createLogger('adapterWithHandleCache');
let reportedUnsupportedHandleCache = false;

/** @internal Test-only reset for deterministic module-state assertions. */
export function __resetUnsupportedHandleCacheReportForTests(): void {
  reportedUnsupportedHandleCache = false;
}

/** Read and validate an adapter's platform-specific handle cache. */
export function readHandleCache<HandleCache>(
  adapter: unknown,
  isHandleCache: (value: unknown) => value is HandleCache
): HandleCache | null {
  if (typeof adapter !== 'object' || adapter === null) {
    return null;
  }
  const candidate = adapter as Record<string, unknown>;
  const getHandleCache = candidate['getHandleCache'];
  if (typeof getHandleCache !== 'function') {
    return null;
  }
  const handleCache = getHandleCache.call(adapter);
  if (handleCache === null || handleCache === undefined) {
    return null;
  }
  if (!isHandleCache(handleCache)) {
    if (!reportedUnsupportedHandleCache) {
      reportedUnsupportedHandleCache = true;
      logger.error('Adapter getHandleCache() returned an unsupported cache shape; cache disabled.');
    }
    return null;
  }
  return handleCache;
}
