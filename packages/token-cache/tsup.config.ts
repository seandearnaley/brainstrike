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
  noExternal: ['xxhash-wasm'],
  loader: {
    '.wasm': 'file',
  },
});
