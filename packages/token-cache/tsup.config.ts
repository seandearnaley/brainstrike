import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/token-cache.worker.ts', 'src/background-indexer.worker.ts'],
  format: ['esm'],
  splitting: false,
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
    '.wasm': 'file',
  },
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
});
