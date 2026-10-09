import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
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

const McpToolsCapabilityContext = createContext<McpToolsCapability | null>(null);

export interface McpToolsCapabilityProviderProps {
  readonly capability: McpToolsCapability | null;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live capability, or `null` when absent. */
export function McpToolsCapabilityProvider({
  capability,
  children,
}: McpToolsCapabilityProviderProps): ReactElement {
  return (
    <McpToolsCapabilityContext.Provider value={capability}>
      {children}
    </McpToolsCapabilityContext.Provider>
  );
}

export function useMcpToolsCapability(): McpToolsCapability | null {
  return useContext(McpToolsCapabilityContext);
}
