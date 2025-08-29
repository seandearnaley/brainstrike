import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  format: ['esm', 'cjs'],
  outDir: 'dist',
  target: 'es2020',
  sourcemap: false,
  clean: true,
  // Ensure vitest's runtime is not bundled into the library to avoid
  // colliding injected globals (vi/expect) in consumer test environments
  external: ['vitest', 'react', 'react/jsx-runtime', '@testing-library/react'],
});
