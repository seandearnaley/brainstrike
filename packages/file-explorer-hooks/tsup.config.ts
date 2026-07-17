import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false, // Don't clean - tsc already generated .d.ts files
  dts: false, // Disable tsup dts generation, use tsc instead
  entry: ['src/index.ts'],
  external: [
    'react',
    'react-dom',
    '@brainstrike/file-explorer',
    '@brainstrike/file-system',
    '@brainstrike/hooks',
    '@brainstrike/platform-utils',
    '@brainstrike/storage',
    '@brainstrike/types',
    '@brainstrike/ui',
    '@brainstrike/utils',
  ],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  splitting: false,
  target: 'es2020',
  tsconfig: './tsconfig.json',
});
