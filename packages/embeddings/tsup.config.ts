import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false,
  dts: false,
  entry: ['src/index.ts'],
  external: ['@huggingface/transformers'],
  format: ['cjs', 'esm'],
  outDir: 'dist',
  sourcemap: true,
  target: 'es2020',
});
