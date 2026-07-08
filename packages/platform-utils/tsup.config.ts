import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  sourcemap: true,
  splitting: false,
}));
