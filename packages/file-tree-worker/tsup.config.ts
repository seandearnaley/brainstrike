import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts', 'src/file-tree.worker.ts'],
  format: ['esm'],
  // Bundle the narrow utils imports used by the worker (collation, UUIDs, and
  // perf timing) so Electron's file:// worker never sees a bare workspace import.
  noExternal: ['@brainstrike/utils'],
  outDir: 'dist',
  platform: 'browser',
  sourcemap: false,
  splitting: false,
  target: 'es2020',
}));
