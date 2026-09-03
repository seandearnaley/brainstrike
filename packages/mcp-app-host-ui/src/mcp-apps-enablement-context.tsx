import type { ReactElement, ReactNode } from 'react';
import { McpAppsEnablementContext, type McpAppsServerEnablement } from './use-mcp-apps-enablement';

export interface McpAppsEnablementProviderProps {
  readonly children: ReactNode;
  /** Resolves the EFFECTIVE Apps state for one configured server id. */
  readonly isEnabled: McpAppsServerEnablement;
}

/** Mount once per host that knows the live MCP extension state (BST-1604). */
export function McpAppsEnablementProvider({
  children,
  isEnabled,
}: McpAppsEnablementProviderProps): ReactElement {
  return (
    <McpAppsEnablementContext.Provider value={isEnabled}>
      {children}
    </McpAppsEnablementContext.Provider>
  );
}
