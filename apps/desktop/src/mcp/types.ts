import type { McpServer } from '../mcp-loader';

export interface McpDiscoveredTool {
  description?: string;
  inputSchema?: unknown;
}

export interface PendingEntry {
  onProgress?: (payload: unknown, meta?: { id?: string }) => void;
  reject: (e: unknown) => void;
  resolve: (v: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface McpClient {
  callTool: (
    tool: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
  ) => Promise<unknown>;
  dispose: () => Promise<void> | void;
  listTools: () => Promise<Record<string, McpDiscoveredTool>>;
  name: string;
  supportsTool: (toolId: string) => boolean;
  transport: McpServer['transport'];
}
