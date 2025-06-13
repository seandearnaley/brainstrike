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
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'esnext', // Target modern browsers for WebAssembly support
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      external: ['electron'],
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            // Group vendor dependencies, but keep PGlite separate
            if (id.includes('@electric-sql/pglite')) {
              return 'pglite';
            }
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
      '@': path.resolve(__dirname, './src/renderer'),
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
      '@brainstrike/app-shell',
      '@brainstrike/file-cache'
    ],
    // Include PGlite for proper bundling
    include: [
      '@electric-sql/pglite'
    ]
  },
  server: {
    port: 8081, // Different port from web app to avoid conflicts
  },
  publicDir: 'public',
});
