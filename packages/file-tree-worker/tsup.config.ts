import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/file-tree.worker.ts'],
  format: ['esm'],
  splitting: false,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'es2020',
  platform: 'browser',
});
