import type { ReactElement, ReactNode } from 'react';
import {
  type McpElicitationCapability,
  McpElicitationCapabilityContext,
} from './use-mcp-elicitation-capability';

export type {
  McpElicitationBridge,
  McpElicitationCapability,
} from './use-mcp-elicitation-capability';

export interface McpElicitationCapabilityProviderProps {
  readonly capability: McpElicitationCapability;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live capabilities. */
export function McpElicitationCapabilityProvider({
  capability,
  children,
}: McpElicitationCapabilityProviderProps): ReactElement {
  return (
    <McpElicitationCapabilityContext.Provider value={capability}>
      {children}
    </McpElicitationCapabilityContext.Provider>
  );
}
