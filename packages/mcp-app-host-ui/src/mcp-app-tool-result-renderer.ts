import { readMcpAppToolInvocationResult } from '@brainstrike/assistant-contract';
import type { ToolResultRenderer } from '@brainstrike/assistant-ui/tool-result-renderers';
import { McpAppToolResult } from './mcp-app-tool-result';

/**
 * The host-registered renderer descriptor. The shared foundation router
 * consults it by RESULT SHAPE; nothing about MCP Apps leaks into that layer.
 */
export const mcpAppToolResultRenderer: ToolResultRenderer = Object.freeze({
  /* biome-ignore lint/style/useNamingConvention: React component slot */
  Component: McpAppToolResult,
  kind: 'mcp-app',
  matches: (result: unknown) => readMcpAppToolInvocationResult(result) !== undefined,
});
