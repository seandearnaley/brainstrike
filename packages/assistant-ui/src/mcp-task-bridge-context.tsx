import type { McpTaskBridge } from '@brainstrike/assistant-contract';
import { createContext, type ReactElement, type ReactNode, use } from 'react';

/**
 * Capability port for live MCP task status (BST-1566). The desktop visible
 * renderer mounts this with `window.mcp.tasks`; web and hidden hosts never
 * provide it, so consumers see `null` and render the persisted snapshot with
 * a visible "live status unavailable" note. Gating is capability-based: the
 * provider is the only signal, there is no host check anywhere below it.
 */
const McpTaskBridgeContext = createContext<McpTaskBridge | null>(null);

export interface McpTaskBridgeProviderProps {
  readonly bridge: McpTaskBridge | null;
  readonly children: ReactNode;
}

export function McpTaskBridgeProvider({
  bridge,
  children,
}: McpTaskBridgeProviderProps): ReactElement {
  return <McpTaskBridgeContext.Provider value={bridge}>{children}</McpTaskBridgeContext.Provider>;
}

/** The live task bridge, or `null` when this host exposes none. */
export function useMcpTaskBridge(): McpTaskBridge | null {
  return use(McpTaskBridgeContext);
}
