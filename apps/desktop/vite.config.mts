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
      external: ['electron', 'chokidar', '@mastra/core', /^@mastra\//],
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            // Group vendor dependencies
            return 'vendor';
          }
          // Explicitly return undefined for other modules to keep them in the default chunk
          return;
        },
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Stylesheets
      {
        find: '@brainstrike/app-shell/styles.css',
        replacement: path.resolve(__dirname, '../../packages/app-shell/styles.css'),
      },
      {
        find: '@brainstrike/file-explorer-ui/styles.css',
        replacement: path.resolve(__dirname, '../../packages/file-explorer-ui/styles.css'),
      },
      // Use source for consistent transforms and single React instance
      {
        find: '@brainstrike/file-explorer-ui',
        replacement: path.resolve(__dirname, '../../packages/file-explorer-ui/src'),
      },
      // NOTE: @brainstrike/token-cache intentionally NOT aliased to src.
      // It uses dist to get the pre-built worker JavaScript file.
      // This matches the @brainstrike/embedding-worker pattern.
      {
        find: '@brainstrike/file-explorer-hooks',
        replacement: path.resolve(__dirname, '../../packages/file-explorer-hooks/src'),
      },
      {
        find: '@brainstrike/file-explorer',
        replacement: path.resolve(__dirname, '../../packages/file-explorer/src'),
      },
      {
        find: '@brainstrike/db',
        replacement: path.resolve(__dirname, '../../packages/db/src/index.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: path.resolve(__dirname, '../../packages/utils/src'),
      },
      {
        find: '@brainstrike/app-shell',
        replacement: path.resolve(__dirname, '../../packages/app-shell/src'),
      },
      {
        find: '@brainstrike/storage',
        replacement: path.resolve(__dirname, '../../packages/storage/src'),
      },
      {
        find: '@brainstrike/file-system',
        replacement: path.resolve(__dirname, '../../packages/file-system/src'),
      },
      {
        find: '@brainstrike/types',
        replacement: path.resolve(__dirname, '../../packages/types/src'),
      },
      {
        find: '@brainstrike/workers',
        replacement: path.resolve(__dirname, '../../packages/workers'),
      },
      {
        // Force pino to browser build to avoid dynamic require of node libs in renderer
        find: 'pino',
        replacement: path.resolve(
          __dirname,
          '../../node_modules/.pnpm/pino@10.1.1/node_modules/pino/browser.js'
        ),
      },
      {
        find: 'pino/browser.js',
        replacement: path.resolve(
          __dirname,
          '../../node_modules/.pnpm/pino@10.1.1/node_modules/pino/browser.js'
        ),
      },
      // Agent client-safe exports (no Mastra dependencies)
      {
        find: '@brainstrike/agent/client',
        replacement: path.resolve(__dirname, '../../packages/agent/src/client.ts'),
      },
      // Force PGlite to use browser FS implementation in renderer to avoid node:fs imports
      {
        find: /@electric-sql\/pglite\/dist\/fs\/nodefs\.js$/,
        replacement: '@electric-sql/pglite/dist/fs/opfs-ahp.js',
      },
      // Fallback for relative import inside pglite dist
      { find: './fs/nodefs.js', replacement: './fs/opfs-ahp.js' },
    ],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
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
      '@brainstrike/db-explorer', // Uses file-import which has worker
      '@brainstrike/file-import', // Contains useChunkingWorker hook - must not be pre-bundled
      '@brainstrike/token-cache', // Worker must resolve via package exports (dist)
      '@brainstrike/chunking-worker', // Worker must resolve via package exports (dist)
    ],
  },
  define: {
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(process.env.EMBED_QUEUE_ENABLED ?? 'true'),
    // Force PGlite to resolve browser implementation in renderer
    'process.versions': 'undefined',
  },
  server: {
    // CRITICAL: keep desktop renderer dev URL deterministic (http://localhost:8081).
    // Electron startup depends on this exact URL; auto-shifting ports causes long
    // startup stalls and non-deterministic renderer boot behavior.
    port: 8081,
    strictPort: true,
    headers: {
      'Content-Security-Policy': getDevCSP(),
    },
  },
  publicDir: 'public',
});
