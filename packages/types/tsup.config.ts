import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
  entry: ['index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  tsconfig: './tsconfig.json',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: !options.watch,
})); 