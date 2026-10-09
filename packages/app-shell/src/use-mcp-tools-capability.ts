import { createContext, useContext } from 'react';
import type { McpToolMap } from './assistant-ui-panel-wrapper-runtime';

/**
 * The discovered MCP tools and their saved preferences, as the composer's Tools
 * menu reads and toggles them. The desktop's agent host owns them (BST-1930
 * c5a); a host without MCP provides none, and the menu lists no MCP tools.
 */
export interface McpToolsCapability {
  list(): Promise<McpToolMap>;
  setEnabled(toolIds: readonly string[], enabled: boolean): Promise<void>;
  /** Every later change to the tools or their preferences. */
  subscribe(listener: (tools: McpToolMap) => void): () => void;
}

/** Provided by `McpToolsCapabilityProvider`; kept here so that module exports only its component. */
export const McpToolsCapabilityContext = createContext<McpToolsCapability | null>(null);

export function useMcpToolsCapability(): McpToolsCapability | null {
  return useContext(McpToolsCapabilityContext);
}
