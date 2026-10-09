import { createContext, useContext } from 'react';
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

/** Provided by `McpContentCapabilityProvider`; kept here so that module exports only its component. */
export const McpContentCapabilityContext = createContext<McpContentCapability | null>(null);

export function useMcpContentCapability(): McpContentCapability | null {
  return useContext(McpContentCapabilityContext);
}
