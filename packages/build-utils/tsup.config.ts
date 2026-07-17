import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false,
  dts: false,
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  sourcemap: true,
  target: 'es2020',
});
