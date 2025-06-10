import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: './', // Use relative paths for Electron
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      external: ['electron'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
    },
  },
  optimizeDeps: {
    // Exclude workspace packages from optimization as they are treated as external
    exclude: [
      '@brainstrike/types',
      '@brainstrike/hooks',
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/file-explorer',
      '@brainstrike/file-explorer-hooks',
      '@brainstrike/file-explorer-ui',
      '@brainstrike/file-system',
      '@brainstrike/storage',
      '@brainstrike/app-shell'
    ]
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 8081, // Different port from web app to avoid conflicts
  },
  publicDir: 'public',
});
