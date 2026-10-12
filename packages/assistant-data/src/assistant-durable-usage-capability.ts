/**
 * Single capability probe for "a durable run owner records assistant usage here".
 *
 * brainstrike is local-first, so the WEB app ALSO runs under a PGlite
 * `DbProvider` — `usePGliteDatabase()` is NON-NULL on web. The presence of a
 * PGlite handle therefore does NOT mean durable assistant usage exists: web
 * assistant turns run on a stateless server and record nothing durable.
 *
 * Desktop runs execute in the agent host, which owns and records each run; the
 * renderer reaches it through the `window.agentHost` bridge. That bridge is the
 * capability (ADR-0008), never the platform: the cost panels, the reload gate
 * and the other durable-run readers gate on it, so web shows its honest
 * session-only state instead of a durable-but-empty one.
 */
export function hasDurableAssistantUsageCapability(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as Window & { agentHost?: unknown }).agentHost !== undefined
  );
}
