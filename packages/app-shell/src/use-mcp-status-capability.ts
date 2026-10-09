import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createContext, useContext } from 'react';

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

/** Provided by `McpStatusCapabilityProvider`; kept here so that module exports only its component. */
export const McpStatusCapabilityContext = createContext<McpStatusCapability | null>(null);

export function useMcpStatusCapability(): McpStatusCapability | null {
  return useContext(McpStatusCapabilityContext);
}
