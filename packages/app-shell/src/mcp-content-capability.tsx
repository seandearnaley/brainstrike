import type { ReactElement, ReactNode } from 'react';
import {
  type McpContentCapability,
  McpContentCapabilityContext,
} from './use-mcp-content-capability';

export type { McpContentCapability } from './use-mcp-content-capability';

export interface McpContentCapabilityProviderProps {
  readonly capability: McpContentCapability | null;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live capability, or `null` when absent. */
export function McpContentCapabilityProvider({
  capability,
  children,
}: McpContentCapabilityProviderProps): ReactElement {
  return (
    <McpContentCapabilityContext.Provider value={capability}>
      {children}
    </McpContentCapabilityContext.Provider>
  );
}
