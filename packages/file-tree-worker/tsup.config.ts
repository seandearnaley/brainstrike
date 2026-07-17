import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts', 'src/file-tree.worker.ts'],
  format: ['esm'],
  // Bundle @brainstrike/utils/tree-operations inline for the worker to work in Electron's
  // file:// context where bare module imports cannot be resolved.
  // We use the /tree-operations subpath to avoid pulling in tiktoken/WASM dependencies.
  noExternal: ['@brainstrike/utils'],
  outDir: 'dist',
  platform: 'browser',
  sourcemap: false,
  splitting: false,
  target: 'es2020',
}));
