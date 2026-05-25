import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/chunking-core.ts',
    'src/token-counting-heuristics.ts',
    'src/token-constants.ts',
    'src/token-utils-accurate-lite.ts',
  ],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  target: 'es2020',
  loader: {
    '.wasm': 'dataurl',
  },
});
