import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: false,
  sourcemap: true,
  target: 'es2020',
  outDir: 'dist',
  external: [
    '@brainstrike/types',
    '@brainstrike/utils',
    '@brainstrike/utils/logger',
    '@brainstrike/utils/log-buffer',
    '@brainstrike/utils/logging-initializer',
    '@brainstrike/utils/logging-preferences',
  ],
});
