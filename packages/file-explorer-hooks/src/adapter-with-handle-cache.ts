/** Adapter capability that exposes its platform-specific persisted handle cache. */
export interface AdapterWithHandleCache<HandleCache> {
  getHandleCache?: () => HandleCache;
}

/** Check whether an unknown adapter exposes the handle-cache capability. */
export function hasGetHandleCache<HandleCache>(
  adapter: unknown
): adapter is AdapterWithHandleCache<HandleCache> {
  if (typeof adapter !== 'object' || adapter === null) {
    return false;
  }
  const candidate = adapter as Record<string, unknown>;
  return typeof candidate['getHandleCache'] === 'function';
}
