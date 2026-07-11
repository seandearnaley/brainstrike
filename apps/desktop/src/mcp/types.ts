import type { McpServer } from '../mcp-loader';

export interface McpDiscoveredTool {
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallOptions {
  onProgress?: (payload: unknown, meta?: { id?: string }) => void;
  signal?: AbortSignal;
}

export interface McpClient {
  callTool: (
    tool: string,
    params?: Record<string, unknown>,
    opts?: McpCallOptions
  ) => Promise<unknown>;
  dispose: () => Promise<void> | void;
  listTools: () => Promise<Record<string, McpDiscoveredTool>>;
  name: string;
  supportsTool: (toolId: string) => boolean;
  transport: McpServer['transport'];
}
