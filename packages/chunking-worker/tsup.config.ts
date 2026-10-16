import { defineConfig } from 'tsup';
// @boundaries-ignore build-time config importing repo build tooling from scripts/; never ships in package output. Shared with token-cache's tsup config; a future move into build-utils would need the config-load-resolves-to-dist ordering solved first (BST-745 class).
import { tokenizerAssetPlugin } from '../../scripts/tiktoken-asset-plugin';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: [
    'src/index.ts',
    'src/canonical.ts',
    'src/chunking.worker.ts',
    'src/source-range-validation.ts',
  ],
  esbuildOptions(options) {
    // Ensure CJS packages are properly converted to ESM for browser
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
  esbuildPlugins: [tokenizerAssetPlugin],
  format: ['esm'],
  loader: {
    // Use dataurl to inline WASM as base64, avoiding file:// fetch issues in Electron
    // and eliminating the need to copy WASM files alongside bundled workers
    '.wasm': 'dataurl',
  },
  // Bundle heavy dependencies into the worker to avoid ESM resolution issues
  noExternal: ['@babel/parser', '@brainstrike/text-splitter', '@brainstrike/tokenization'],
  outDir: 'dist',
  platform: 'browser', // Force browser-compatible output (no require())
  sourcemap: false,
  splitting: true,
  target: 'es2020',
}));
