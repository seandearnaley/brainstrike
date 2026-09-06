import type { McpAppBridge } from '@brainstrike/assistant-contract';
import { createContext, use } from 'react';

/**
 * Capability port for production MCP Apps (BST-1572). The desktop visible
 * renderer provides `window.mcp.apps`; web and hidden hosts never provide it,
 * so consumers see `null` and render the ordinary tool result with a visible
 * "App rendering unavailable in this host" note. Gating is capability-based:
 * the provider is the only signal, there is no host check anywhere below it.
 * Kept out of the provider module so that file stays a Fast Refresh boundary.
 */
export const McpAppBridgeContext = createContext<McpAppBridge | null>(null);

/** The MCP Apps host bridge, or `null` when this host exposes none. */
export function useMcpAppBridge(): McpAppBridge | null {
  return use(McpAppBridgeContext);
}
