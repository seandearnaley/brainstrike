import { defineConfig } from 'vite';

// BST-1940 spike: production build of the harness page and both engine workers. No COOP/COEP:
// opfs-sahpool needs no SharedArrayBuffer (only the "opfs" VFS does).
export default defineConfig({
  build: { emptyOutDir: true, outDir: 'dist', reportCompressedSize: false, target: 'es2022' },
  optimizeDeps: {
    exclude: [
      '@sqlite.org/sqlite-wasm',
      '@electric-sql/pglite',
      '@electric-sql/pglite-pgvector',
      '@electric-sql/pglite-pg_textsearch',
    ],
  },
  preview: { host: '127.0.0.1', port: 4179, strictPort: true },
  worker: { format: 'es' },
});
