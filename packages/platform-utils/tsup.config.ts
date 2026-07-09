import { defineConfig } from 'tsup';

export default defineConfig((_options) => ({
  // Keep tsc -b declaration emit; cleaning would delete dist/*.d.ts.
  clean: false,
  // Declarations come from `tsc -b` — tsup's DTS path still injects baseUrl
  // (egoist/tsup#1388) which is a hard error under native TypeScript 7.
  dts: false,
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  sourcemap: true,
  splitting: false,
}));
