import type { McpAppBridge } from '@brainstrike/assistant-contract';
import type { ReactElement, ReactNode } from 'react';
import { McpAppBridgeContext } from './use-mcp-app-bridge';

export interface McpAppBridgeProviderProps {
  readonly bridge: McpAppBridge | null;
  readonly children: ReactNode;
}

/** Mount once per visible host with the apps bridge, or `null` when absent. */
export function McpAppBridgeProvider({
  bridge,
  children,
}: McpAppBridgeProviderProps): ReactElement {
  return <McpAppBridgeContext.Provider value={bridge}>{children}</McpAppBridgeContext.Provider>;
}
