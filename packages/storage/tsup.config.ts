import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false, // Don't clean - tsc already generated .d.ts files
  dts: false, // Disable tsup dts generation, use tsc instead
  entry: ['src/index.ts', 'src/electron.ts'],
  external: ['@brainstrike/types', 'zustand', 'electron'],
  format: ['cjs', 'esm'],
  sourcemap: true,
  splitting: false, // Bundle into a single file so relative imports don't need runtime extensions
  target: 'es2020',
});
