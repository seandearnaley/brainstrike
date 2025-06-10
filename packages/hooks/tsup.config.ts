import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/*.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  clean: false,
  sourcemap: true,
  target: 'es2020',
  outDir: 'dist',
});
