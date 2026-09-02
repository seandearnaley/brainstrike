import type { McpTaskBridge } from '@brainstrike/assistant-contract';
import type { ReactElement, ReactNode } from 'react';
import { McpTaskBridgeContext } from './use-mcp-task-bridge';

export interface McpTaskBridgeProviderProps {
  readonly bridge: McpTaskBridge | null;
  readonly children: ReactNode;
}

/** Mount once per visible host with the live bridge, or `null` when absent. */
export function McpTaskBridgeProvider({
  bridge,
  children,
}: McpTaskBridgeProviderProps): ReactElement {
  return <McpTaskBridgeContext.Provider value={bridge}>{children}</McpTaskBridgeContext.Provider>;
}
