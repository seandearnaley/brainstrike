import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const accurateTokenRuntimeSource = fileURLToPath(
  new URL('../utils/src/token-utils-accurate-lite.ts', import.meta.url)
);

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts', 'src/chunking.worker.ts'],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@brainstrike/utils/token-utils-accurate-lite': accurateTokenRuntimeSource,
    };
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
  format: ['esm'],
  loader: {
    // Use dataurl to inline WASM as base64, avoiding file:// fetch issues in Electron
    // and eliminating the need to copy WASM files alongside bundled workers
    '.wasm': 'dataurl',
  },
  // Bundle heavy dependencies into the worker to avoid ESM resolution issues
  noExternal: ['@babel/parser', '@brainstrike/text-splitter', '@brainstrike/utils', 'tiktoken'],
  outDir: 'dist',
  platform: 'browser', // Force browser-compatible output (no require())
  sourcemap: false,
  splitting: true,
  target: 'es2020',
}));
