/**
 * Single capability probe for "a durable run owner records assistant usage here".
 *
 * Runs execute in the agent host, which owns and records each run; the
 * renderer reaches it through the `window.agentHost` bridge. That bridge is the
 * capability (ADR-0008), never the platform: the cost panels, the reload gate
 * and the other durable-run readers gate on it, so a surface without the bridge
 * (tests, an isolated renderer) shows an honest "not recorded here" state
 * instead of a durable-but-empty one.
 */
export function hasDurableAssistantUsageCapability(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as Window & { agentHost?: unknown }).agentHost !== undefined
  );
}
