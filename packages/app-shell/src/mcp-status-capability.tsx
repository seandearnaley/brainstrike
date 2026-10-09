import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';

/**
 * The MCP runtime's server status, as the composer's prompt affordances read
 * and follow it. The desktop's agent host owns it (BST-1930 c5b); a host
 * without MCP provides none.
 */
export interface McpStatusCapability {
  read(): Promise<McpHostSnapshot>;
  /** Every later status revision, each a whole snapshot. */
  subscribe(listener: (status: McpHostSnapshot) => void): () => void;
}

const McpStatusCapabilityContext = createContext<McpStatusCapability | null>(null);

export interface McpStatusCapabilityProviderProps {
  readonly capability: McpStatusCapability | null;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live capability, or `null` when absent. */
export function McpStatusCapabilityProvider({
  capability,
  children,
}: McpStatusCapabilityProviderProps): ReactElement {
  return (
    <McpStatusCapabilityContext.Provider value={capability}>
      {children}
    </McpStatusCapabilityContext.Provider>
  );
}

export function useMcpStatusCapability(): McpStatusCapability | null {
  return useContext(McpStatusCapabilityContext);
}
