import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts'],
  // Ensure vitest's runtime is not bundled into the library to avoid
  // colliding injected globals (vi/expect) in consumer test environments
  external: ['vitest', 'react', 'react/jsx-runtime', '@testing-library/react'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  target: 'es2020',
}));
