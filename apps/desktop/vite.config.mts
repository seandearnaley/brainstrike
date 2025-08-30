import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPGliteWasm, fullReloadOnCompilerHotspots } from '@brainstrike/build-utils';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { getDevCSP } from './src/csp-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wasmPath = findPGliteWasm(__dirname);

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' };

export default defineConfig({
  root: __dirname,
  base: './', // Use relative paths for Electron
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
      },
      jsxRuntime: 'automatic',
    }),
    tailwindcss(),
    ...(wasmPath
      ? [
          viteStaticCopy({
            targets: [
              {
                src: wasmPath,
                dest: 'assets',
              },
            ],
          }),
        ]
      : []),
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
      external: ['electron', 'chokidar'],
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            // Group vendor dependencies
            return 'vendor';
          }
          // Explicitly return undefined for other modules to keep them in the default chunk
          return undefined;
        },
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Map stylesheet import to package root css before package alias
      '@brainstrike/file-explorer-ui/styles.css': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/styles.css'
      ),
      // Use source for consistent transforms and single React instance
      '@brainstrike/file-explorer-ui': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/src'
      ),
      '@brainstrike/file-explorer-hooks': path.resolve(
        __dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
      // remove duplicate hooks alias
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../../packages/file-system/src'),
      '@brainstrike/types': path.resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/workers': path.resolve(__dirname, '../../packages/workers'),
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: [
      '@electric-sql/pglite',
      '@electric-sql/pglite/vector',
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
      '@brainstrike/workers',
    ],
  },
  define: {
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(process.env.EMBED_QUEUE_ENABLED ?? 'true'),
  },
  server: {
    port: 8081, // Different port from web app to avoid conflicts
    headers: {
      'Content-Security-Policy': getDevCSP(),
    },
  },
  publicDir: 'public',
});
