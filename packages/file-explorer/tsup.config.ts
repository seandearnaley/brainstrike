import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/persistence/worker-storage.worker.ts'],
  format: ['esm', 'cjs'],
  splitting: false,
  clean: false,
  target: 'es2022',
  dts: false,
  injectStyle: false,
  // Copy the transpiled worker (Rollup/Vite emits ".worker.js") as a separate asset so
  // it can be loaded at runtime without bundling issues.
  loader: { '.worker.js': 'copy' },
});
