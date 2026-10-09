/**
 * Capability resolution for the desktop `window.mcp.apps` shell bridge (BST-1572).
 *
 * The visible-UI preload exposes the app shell and document reads as
 * `window.mcp.apps`; hidden hosts and web have no such member. The bridge is
 * resolved by probing its three members (no `isElectron()` check) and is
 * `null` when any is missing, so the thread UI renders the ordinary tool
 * result with a visible "App rendering unavailable in this host" note instead
 * of a half-wired host.
 */
import type { McpAppShellBridge } from '@brainstrike/assistant-contract';

const SHELL_METHODS = [
  'prepareShell',
  'readResource',
  'releaseShell',
] as const satisfies readonly (keyof McpAppShellBridge)[];

interface McpAppShellBridgeHost {
  readonly mcp?: { readonly apps?: unknown };
}

function isMcpAppShellBridge(candidate: unknown): candidate is McpAppShellBridge {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const members = candidate as Partial<Record<keyof McpAppShellBridge, unknown>>;
  return SHELL_METHODS.every((method) => typeof members[method] === 'function');
}

/** Resolve `window.mcp.apps`, or `null` when this host exposes no complete shell bridge. */
export function resolveMcpAppShellBridge(
  host: McpAppShellBridgeHost | undefined = readWindowHost()
): McpAppShellBridge | null {
  const candidate = host?.mcp?.apps;
  return isMcpAppShellBridge(candidate) ? candidate : null;
}

function readWindowHost(): McpAppShellBridgeHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as McpAppShellBridgeHost);
}
