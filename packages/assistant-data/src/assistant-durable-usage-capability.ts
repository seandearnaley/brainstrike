/**
 * Single capability probe for "durable assistant usage is recorded here".
 *
 * brainstrike is local-first, so the WEB app ALSO runs under a PGlite
 * `DbProvider` — `usePGliteDatabase()` is NON-NULL on web. The presence of a
 * PGlite handle therefore does NOT mean durable assistant usage exists: web
 * assistant turns use the in-renderer LocalRuntimeChat (session-only) and never
 * call `recordRunUsage`. Durable usage rows are written only on DESKTOP, where
 * chat routes through the assistant server's Mastra loop.
 *
 * The authoritative signal is the desktop assistant server bridge
 * (`window.assistant.url` / `getUrl`) — the same capability that gates the
 * durable WRITE path (`hasDesktopAssistantBackend` in
 * assistant-ui-panel-wrapper.tsx) and the data-stream transport. The cost panel
 * READS the durable store, so it must gate on the same signal as the WRITE,
 * not on the raw PGlite handle, or web users see a durable-but-empty panel
 * instead of the intended honest session-only state.
 */
export function hasDurableAssistantUsageCapability(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const bridge = (window as unknown as { assistant?: { getUrl?: unknown; url?: unknown } })
    .assistant;
  // Gate on the SHAPE of the capability, not a truthy proxy: a non-empty string
  // `url` or a callable `getUrl`. A truthy-but-wrong value (e.g. `url: {}`) would
  // otherwise pass here and throw downstream when the URL is actually used.
  return Boolean(
    bridge &&
      ((typeof bridge.url === 'string' && bridge.url.length > 0) ||
        typeof bridge.getUrl === 'function')
  );
}
