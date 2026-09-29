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
    electronAPI?: import('../src/types/desktop-electron-api').VisibleDesktopElectronApi;
    // Shape defined ONCE in
    // @brainstrike/assistant-contract/env-bootstrap-bridge. Declared so an
    // e2e spec can stub the env bootstrap projection and drive the Settings
    // Environment section (BST-1363) without real .env files on disk.
    envBootstrap?: Partial<
      import('@brainstrike/assistant-contract/env-bootstrap-bridge').EnvBootstrapBridge
    >;
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
