/// <reference types="node" />
/// <reference types="@playwright/test" />

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      CI?: string;
      NODE_ENV?: string;
      [key: string]: string | undefined;
    }
  }
  interface Window {
    agent?: {
      chat?: (messages: unknown[], runtime?: unknown) => Promise<unknown[]>;
    };
    mcp?: {
      getConfig?: () => Promise<unknown>;
      watch?: () => Promise<{ watching: boolean }>;
      unwatch?: () => Promise<{ watching: false }>;
    };
    // Shape defined ONCE in @brainstrike/assistant-contract/secrets-bridge;
    // e2e keeps every method optional (bridge presence is capability-checked).
    secrets?: Partial<import('@brainstrike/assistant-contract/secrets-bridge').SecretsBridge>;
  }
}

export {};
