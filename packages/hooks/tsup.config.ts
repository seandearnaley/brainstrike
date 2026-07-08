import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false, // Don't clean - tsc already generated .d.ts files
  dts: false, // Disable tsup dts generation, use tsc instead
  entry: ['src/index.ts'],
  external: [
    'react',
    'react-dom',
    '@brainstrike/types',
    '@brainstrike/utils',
    '@brainstrike/file-system',
    'file-saver',
  ],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  splitting: false,
  target: 'es2020',
  tsconfig: './tsconfig.json',
});
