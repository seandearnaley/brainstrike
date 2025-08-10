import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/workers/lazy-tree.worker.ts'],
  format: ['esm', 'cjs'],
  splitting: false,
  clean: false,
  target: 'es2022',
  dts: false,
  injectStyle: false,
  loader: { '.worker.js': 'copy' },
});
