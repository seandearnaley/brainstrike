import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts', 'src/chunking.worker.ts'],
  format: ['esm'],
  splitting: true,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: !options.watch,
  target: 'es2020',
  platform: 'browser', // Force browser-compatible output (no require())
  // Bundle heavy dependencies into the worker to avoid ESM resolution issues
  noExternal: ['@babel/parser', '@brainstrike/text-splitter', '@brainstrike/utils', 'tiktoken'],
  loader: {
    // Use dataurl to inline WASM as base64, avoiding file:// fetch issues in Electron
    // and eliminating the need to copy WASM files alongside bundled workers
    '.wasm': 'dataurl',
  },
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
}));
