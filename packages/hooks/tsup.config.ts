import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // Disable tsup dts generation, use tsc instead
  outDir: 'dist',
  clean: false, // Don't clean - tsc already generated .d.ts files
  target: 'es2020',
  splitting: false,
  sourcemap: false,
  external: [
    'react',
    'react-dom',
    '@brainstrike/types',
    '@brainstrike/utils',
    '@brainstrike/ui',
    '@brainstrike/file-system',
    'file-saver',
  ],
  tsconfig: './tsconfig.json',
});