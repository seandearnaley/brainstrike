/** Adapter capability that exposes its platform-specific persisted handle cache. */
export interface AdapterWithHandleCache<HandleCache> {
  getHandleCache?: () => HandleCache;
}
