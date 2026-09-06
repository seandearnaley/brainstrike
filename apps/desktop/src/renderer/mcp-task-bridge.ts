/**
 * Capability resolution for the desktop `window.mcp.tasks` bridge (BST-1566).
 *
 * The visible-UI preload exposes `McpTaskBridge` as `window.mcp.tasks`; hidden
 * hosts and web have no such member. The bridge is resolved by probing the
 * three required members (no `isElectron()` check) and is `null` when any is
 * missing, so the thread UI renders persisted snapshots with a visible
 * "live status unavailable" note instead of a half-wired bridge.
 */
import type { McpTaskBridge } from '@brainstrike/assistant-contract';

const BRIDGE_METHODS = [
  'act',
  'list',
  'onStatusChanged',
] as const satisfies readonly (keyof McpTaskBridge)[];

interface McpTaskBridgeHost {
  readonly mcp?: { readonly tasks?: unknown };
}

function isMcpTaskBridge(candidate: unknown): candidate is McpTaskBridge {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const members = candidate as Partial<Record<keyof McpTaskBridge, unknown>>;
  return BRIDGE_METHODS.every((method) => typeof members[method] === 'function');
}

/** Resolve `window.mcp.tasks`, or `null` when this host exposes no complete bridge. */
export function resolveMcpTaskBridge(
  host: McpTaskBridgeHost | undefined = readWindowHost()
): McpTaskBridge | null {
  const candidate = host?.mcp?.tasks;
  return isMcpTaskBridge(candidate) ? candidate : null;
}

function readWindowHost(): McpTaskBridgeHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as McpTaskBridgeHost);
}
