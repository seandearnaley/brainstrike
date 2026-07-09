import { defineConfig } from 'tsup';

export default defineConfig((_options) => ({
  // Keep tsc -b declaration emit; cleaning would delete dist/*.d.ts.
  clean: false,
  // Declarations come from `tsc -b` — tsup's DTS path still injects baseUrl
  // (egoist/tsup#1388) which is a hard error under native TypeScript 7.
  dts: false,
  entry: ['src/index.ts'],
  // Ensure vitest's runtime is not bundled into the library to avoid
  // colliding injected globals (vi/expect) in consumer test environments
  external: ['vitest', 'react', 'react/jsx-runtime', '@testing-library/react'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  target: 'es2020',
}));
