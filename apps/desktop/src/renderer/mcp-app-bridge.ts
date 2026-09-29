/**
 * Capability resolution for the desktop `window.mcp.apps` bridge (BST-1572).
 *
 * The visible-UI preload exposes `McpAppBridge` as `window.mcp.apps`; hidden
 * hosts and web have no such member. The bridge is resolved by probing the
 * six required members (no `isElectron()` check) and is `null` when any is
 * missing, so the thread UI renders the ordinary tool result with a visible
 * "App rendering unavailable in this host" note instead of a half-wired host.
 */
import type { McpAppBridge } from '@brainstrike/assistant-contract';

const BRIDGE_METHODS = [
  'execute',
  'prepare',
  'prepareShell',
  'readResource',
  'release',
  'releaseShell',
] as const satisfies readonly (keyof McpAppBridge)[];

interface McpAppBridgeHost {
  readonly mcp?: { readonly apps?: unknown };
}

function isMcpAppBridge(candidate: unknown): candidate is McpAppBridge {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const members = candidate as Partial<Record<keyof McpAppBridge, unknown>>;
  return BRIDGE_METHODS.every((method) => typeof members[method] === 'function');
}

/** Resolve `window.mcp.apps`, or `null` when this host exposes no complete bridge. */
export function resolveMcpAppBridge(
  host: McpAppBridgeHost | undefined = readWindowHost()
): McpAppBridge | null {
  const candidate = host?.mcp?.apps;
  return isMcpAppBridge(candidate) ? candidate : null;
}

function readWindowHost(): McpAppBridgeHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as McpAppBridgeHost);
}
