/// <reference types="node" />

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