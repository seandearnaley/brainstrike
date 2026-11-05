import {
  createMcpAppToolInvocationResult,
  MCP_APPS_MIME_TYPE,
  type McpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import type { McpAppResourceUri } from '@brainstrike/mcp-app-host/metadata';

export interface McpAppToolResultOrigin {
  readonly resourceUri: McpAppResourceUri;
  readonly serverId: string;
  readonly toolName: string;
}

/** Preserve the ordinary domain result under the renderer-owned Apps marker. */
export function createMcpAppToolResult(
  origin: McpAppToolResultOrigin | undefined,
  ordinaryResult: unknown
): McpAppToolInvocationResult | unknown {
  if (!origin) {
    return ordinaryResult;
  }
  return createMcpAppToolInvocationResult(
    {
      mimeType: MCP_APPS_MIME_TYPE,
      resourceUri: origin.resourceUri,
      serverId: origin.serverId,
      toolName: origin.toolName,
    },
    ordinaryResult
  );
}
