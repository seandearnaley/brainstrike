import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: path.resolve(__dirname, '.vite'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      src: path.resolve(__dirname, 'src'),
      '@brainstrike/types': path.resolve(__dirname, '../types/src'),
      '@brainstrike/utils': path.resolve(__dirname, '../utils/src'),
      '@brainstrike/platform-utils': path.resolve(__dirname, '../platform-utils/src'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../file-explorer/src'),
      '@brainstrike/file-explorer-ui': path.resolve(__dirname, '../file-explorer-ui/src'),
      '@brainstrike/file-explorer-hooks': path.resolve(__dirname, '../file-explorer-hooks/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../storage/src'),
      '@brainstrike/ui': path.resolve(__dirname, '../ui/src'),
    },
  },
  plugins: [wasm()],
  optimizeDeps: {
    // Split pgvector package ships its WASM/tar via import.meta.url; prebundling
    // into .vite/deps breaks that relative asset URL, so exclude like core PGlite.
    exclude: ['@electric-sql/pglite', '@electric-sql/pglite-pgvector'],
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
});
