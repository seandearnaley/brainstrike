declare module 'node:fs';
declare module 'node:fs/promises';
declare module 'node:path';
declare const process: { cwd: () => string };
declare module 'electron' {
  export const app: {
    whenReady: () => Promise<void>;
    getPath: (name: string) => string;
  };
}
