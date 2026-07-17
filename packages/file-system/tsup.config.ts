import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false, // Don't clean - tsc already generated .d.ts files
  dts: false, // Disable tsup dts generation, use tsc instead
  entry: ['src/index.ts', 'src/electron.ts', 'src/path-validation.ts'],
  external: ['@brainstrike/types', 'electron', 'chokidar'],
  format: ['cjs', 'esm'],
  sourcemap: true,
  splitting: false, // Bundle to avoid extensionless relative imports in dist
  target: 'es2020',
});
