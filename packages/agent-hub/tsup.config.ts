import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm'],
  splitting: false,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: !options.watch,
  target: 'es2020',
  platform: 'neutral',
}));
