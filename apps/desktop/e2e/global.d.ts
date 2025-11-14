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
    secrets?: {
      saveKey?: (
        provider: string,
        value: string
      ) => Promise<{ ok?: boolean; error?: string } | undefined>;
      getKey?: (provider: string) => Promise<string | null>;
      deleteKey?: (provider: string) => Promise<void>;
      list?: () => Promise<string[]>;
      listStored?: () => Promise<string[]>;
      clearAll?: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
    mcp?: {
      getConfig?: () => Promise<unknown>;
      watch?: () => Promise<{ watching: boolean }>;
      unwatch?: () => Promise<{ watching: false }>;
    };
  }
}

export {};
