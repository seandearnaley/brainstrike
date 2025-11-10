import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    dts: false,
    format: ['esm', 'cjs'],
    target: 'es2020',
    sourcemap: false,
    clean: true,
    outDir: 'dist',
  },
  {
    entry: { cli: 'src/cli.ts' },
    dts: false,
    format: ['esm'],
    target: 'es2020',
    sourcemap: false,
    clean: false,
    outDir: 'dist',
  },
]);
