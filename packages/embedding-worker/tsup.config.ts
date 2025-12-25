import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/embedding.worker.ts'],
  format: ['esm'],
  splitting: false,
  sourcemap: false,
  dts: false,
  outDir: 'dist',
  clean: false,
  target: 'es2020',
});
