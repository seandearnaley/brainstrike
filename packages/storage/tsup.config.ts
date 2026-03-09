import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/electron.ts'],
  format: ['cjs', 'esm'],
  dts: false, // Disable tsup dts generation, use tsc instead
  clean: false, // Don't clean - tsc already generated .d.ts files
  sourcemap: true,
  target: 'es2020',
  splitting: false, // Bundle into a single file so relative imports don't need runtime extensions
  external: ['@brainstrike/types', 'zustand', 'electron'],
});
