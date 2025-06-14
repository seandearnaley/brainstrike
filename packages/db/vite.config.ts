import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'src': path.resolve(__dirname, 'src'),
      '@brainstrike/types': path.resolve(__dirname, '../../types/src'),
      '@brainstrike/utils': path.resolve(__dirname, '../../utils/src'),
      '@brainstrike/platform-utils': path.resolve(__dirname, '../../platform-utils/src'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../file-explorer/src'),
      '@brainstrike/file-explorer-ui': path.resolve(__dirname, '../../file-explorer-ui/src'),
      '@brainstrike/file-explorer-hooks': path.resolve(__dirname, '../../file-explorer-hooks/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../../storage/src'),
      '@brainstrike/ui': path.resolve(__dirname, '../../ui/src'),
    },
  },
  plugins: [
    wasm(),
    topLevelAwait(),
    viteStaticCopy({
      targets: [
        {
          src: '../../node_modules/@electric-sql/pglite/dist/pglite.wasm',
          dest: 'assets',
        },
      ],
    }),
  ],
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
});
