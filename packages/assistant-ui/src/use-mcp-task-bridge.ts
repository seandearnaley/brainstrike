import type { McpTaskBridge } from '@brainstrike/assistant-contract';
import { createContext, use } from 'react';

/**
 * Capability port for live MCP task status (BST-1566). The desktop visible
 * renderer provides `window.mcp.tasks`; web and hidden hosts never provide
 * it, so consumers see `null` and render the persisted snapshot with a
 * visible "live status unavailable" note. Gating is capability-based: the
 * provider is the only signal, there is no host check anywhere below it.
 * Kept out of the provider module so that file stays a Fast Refresh boundary.
 */
export const McpTaskBridgeContext = createContext<McpTaskBridge | null>(null);

/** The live task bridge, or `null` when this host exposes none. */
export function useMcpTaskBridge(): McpTaskBridge | null {
  return use(McpTaskBridgeContext);
}
