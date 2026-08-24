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
    throw new TypeError('Adapter getHandleCache() returned an unsupported cache shape.');
  }
  return handleCache;
}
