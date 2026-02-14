declare global {
  interface Window {
    agent?: {
      chat?: (messages: unknown[], runtime?: unknown) => Promise<unknown[]>;
    };
    mcp?: {
      getConfig?: () => Promise<
        | {
            path: string;
            exists: boolean;
            servers?: Array<{ name: string; transport: 'stdio' | 'sse' }>;
          }
        | undefined
      >;
      watch?: () => Promise<{ watching: boolean }>;
      unwatch?: () => Promise<{ watching: false }>;
      listTools?: () => Promise<
        Record<
          string,
          Array<{
            id: string;
            description?: string;
            inputSchema?: unknown;
            enabled: boolean;
          }>
        >
      >;
      enableTools?: (toolIds: string[]) => Promise<void>;
      disableTools?: (toolIds: string[]) => Promise<void>;
    };
    tools?: {
      execute?: (
        toolId: string,
        input: unknown
      ) => Promise<{
        success: boolean;
        result?: unknown;
        error?: string;
        durationMs: number;
      }>;
      onRootTreeSelectionUpdate?: (
        callback: (payload: {
          folderId: string;
          filePaths: string[];
          mode: 'replace' | 'add' | 'remove';
        }) => void
      ) => (() => void) | undefined;
      onPreviewContextSelectionUpdate?: (
        callback: (payload: {
          folderId: string;
          filePaths: string[];
          mode: 'replace' | 'add' | 'remove';
        }) => void
      ) => (() => void) | undefined;
    };
  }
}

export {};
