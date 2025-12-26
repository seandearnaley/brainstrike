import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/chunking.worker.ts'],
  format: ['esm'],
  splitting: false,
  sourcemap: false,
  dts: true,
  outDir: 'dist',
  clean: true,
  target: 'es2020',
  platform: 'browser', // Force browser-compatible output (no require())
  // Bundle heavy dependencies into the worker to avoid ESM resolution issues
  noExternal: ['@babel/parser', '@langchain/textsplitters', 'tiktoken'],
  loader: {
    '.wasm': 'file',
  },
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
});
