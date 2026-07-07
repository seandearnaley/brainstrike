import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: [
    'src/index.ts',
    'src/cache-runtime.ts',
    'src/background-indexer.ts',
    'src/token-cache.worker.ts',
    'src/background-indexer.worker.ts',
  ],
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
  external: ['worker_threads', 'os', 'child_process'],
  format: ['esm'],
  loader: {
    // Use dataurl to inline WASM as base64, avoiding file:// fetch issues in Electron
    // and eliminating the need to copy WASM files alongside bundled workers
    '.wasm': 'dataurl',
  },
  // Keep these browser-only dependencies bundled so tsup can emit shared split
  // chunks (for example o200k_base/tiktoken_bg/token-utils-accurate-lite) once
  // across the worker and runtime entrypoints instead of relying on external ESM
  // resolution inside worker contexts.
  noExternal: ['@brainstrike/text-splitter', '@brainstrike/utils', 'xxhash-wasm', 'tiktoken'],
  outDir: 'dist',
  platform: 'browser',
  sourcemap: false,
  splitting: true,
  target: 'es2020',
}));
