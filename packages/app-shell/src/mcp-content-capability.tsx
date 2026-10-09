import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type {
  McpPromptCompleteRequest,
  McpPromptCompleteResult,
  McpPromptGetRequest,
  McpPromptGetResult,
} from './mcp-prompts/mcp-prompt-bridge';

/**
 * MCP content the composer's prompt affordances read: a prompt's messages and
 * an argument's completions, from one connected server generation. The
 * desktop's agent host serves it (BST-1930 c5d); a host without MCP provides
 * none.
 */
export interface McpContentCapability {
  complete(request: McpPromptCompleteRequest): Promise<McpPromptCompleteResult>;
  getPrompt(request: McpPromptGetRequest): Promise<McpPromptGetResult>;
}

const McpContentCapabilityContext = createContext<McpContentCapability | null>(null);

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

export function useMcpContentCapability(): McpContentCapability | null {
  return useContext(McpContentCapabilityContext);
}
