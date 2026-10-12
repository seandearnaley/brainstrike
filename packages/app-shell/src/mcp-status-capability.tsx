import type { ReactElement, ReactNode } from 'react';
import { type McpStatusCapability, McpStatusCapabilityContext } from './use-mcp-status-capability';

export type { McpStatusCapability } from './use-mcp-status-capability';

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
