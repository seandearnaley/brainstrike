import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: './', // Use relative paths for Electron
  plugins: [
    react(),
    tailwindcss(),
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
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      external: ['electron'],
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            // Group vendor dependencies
            return "vendor";
          }
          // Explicitly return undefined for other modules to keep them in the default chunk
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/dist/index.js'),
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: [
      '@electric-sql/pglite',
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
  server: {
    port: 8081, // Different port from web app to avoid conflicts
  },
  publicDir: 'public',
});
