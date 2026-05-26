import { defineConfig } from 'tsup';

// text-splitter's accurate token-counting modules are thin re-export shims
// over @brainstrike/utils; no wasm assets are bundled here (tiktoken stays
// external via workspace deps). Sourcemaps match utils so worker stacktraces
// resolve through the shim layer.
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
  sourcemap: true,
  target: 'es2020',
});
