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
  noExternal: ['xxhash-wasm', 'workerpool'],
  external: ['worker_threads', 'os', 'child_process'],
  loader: {
    '.wasm': 'file',
  },
});
