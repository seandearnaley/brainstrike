import type { McpServer } from '../mcp-loader';

export type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  onProgress?: (payload: unknown, meta?: { id?: string }) => void;
};

export type McpClient = {
  name: string;
  transport: McpServer['transport'];
  dispose: () => Promise<void> | void;
  callTool: (
    tool: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
  ) => Promise<unknown>;
};
