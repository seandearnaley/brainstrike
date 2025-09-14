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
    };
  }
}

export {};
