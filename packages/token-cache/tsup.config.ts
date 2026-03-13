import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cache-runtime.ts',
    'src/background-indexer.ts',
    'src/token-cache.worker.ts',
    'src/background-indexer.worker.ts',
  ],
  format: ['esm'],
  splitting: true,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'es2020',
  platform: 'browser',
  // Bundle heavy dependencies into the worker to avoid ESM resolution issues
  noExternal: ['xxhash-wasm', 'workerpool', 'tiktoken'],
  external: ['worker_threads', 'os', 'child_process'],
  loader: {
    // Use dataurl to inline WASM as base64, avoiding file:// fetch issues in Electron
    // and eliminating the need to copy WASM files alongside bundled workers
    '.wasm': 'dataurl',
  },
  // Workerpool bundles a sourceMappingURL comment that points to worker.min.js.map.
  // Ensure the file exists in dist so Vite/dev tooling does not spam ENOENT warnings.
  onSuccess: 'node ./scripts/ensure-workerpool-sourcemap.mjs',
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
});
