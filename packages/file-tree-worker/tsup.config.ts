import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/file-tree.worker.ts'],
  format: ['esm'],
  splitting: false,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'es2020',
  platform: 'browser',
  // Bundle @brainstrike/utils/tree-operations inline for the worker to work in Electron's
  // file:// context where bare module imports cannot be resolved.
  // We use the /tree-operations subpath to avoid pulling in tiktoken/WASM dependencies.
  noExternal: ['@brainstrike/utils'],
});
