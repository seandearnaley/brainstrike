import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/path-validation.ts'],
  format: ['cjs', 'esm'],
  dts: false, // Disable tsup dts generation, use tsc instead
  clean: false, // Don't clean - tsc already generated .d.ts files
  sourcemap: true,
  target: 'es2020',
  splitting: false, // Bundle to avoid extensionless relative imports in dist
  external: ['@brainstrike/types', 'electron', 'chokidar'],
});
