import type { ReactElement, ReactNode } from 'react';
import { type McpToolsCapability, McpToolsCapabilityContext } from './use-mcp-tools-capability';

export type { McpToolsCapability } from './use-mcp-tools-capability';

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
