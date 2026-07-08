import { defineConfig } from 'tsup';

export default defineConfig((options) => [
  {
    clean: !options.watch,
    dts: false,
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
  {
    clean: false,
    dts: false,
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
]);
