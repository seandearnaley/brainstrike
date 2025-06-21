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
}

export {};