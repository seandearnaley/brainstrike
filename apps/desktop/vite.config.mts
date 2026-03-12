import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getLazySurfaceOptimizeDepsEntries,
  resolveAssistantVendorChunk,
} from '@brainstrike/build-utils';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { getDevCSP } from './src/csp-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pinoBrowserPath = require.resolve('pino/browser.js');

const wasmPath = findPGliteWasm(__dirname);

function resolveVendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) {
    return;
  }

  const assistantChunk = resolveAssistantVendorChunk(id);
  if (assistantChunk) {
    return assistantChunk;
  }

  return 'vendor';
}

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' };
// CRITICAL: Keep React/Babel transforms scoped to source files only.
// Letting the React plugin process package dist artifacts (especially large worker bundles)
// causes multi-second startup stalls in desktop dev while Vite/Babel reprocesses megabytes
// of non-React code before first paint.
const ReactPluginInclude = [
  /[/\\]apps[/\\]desktop[/\\]src[/\\].*\.[jt]sx?$/,
  /[/\\]packages[/\\][^/\\]+[/\\]src[/\\].*\.[jt]sx?$/,
];

export default defineConfig({
  root: __dirname,
  base: './', // Use relative paths for Electron
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      include: ReactPluginInclude,
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
        manualChunks: resolveVendorChunk,
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
      {
        find: '@brainstrike/ui/styles.css',
        replacement: path.resolve(__dirname, '../../packages/ui/styles.css'),
      },
      {
        find: '@brainstrike/ui/globals.css',
        replacement: path.resolve(__dirname, '../../packages/ui/src/globals.css'),
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
        find: '@brainstrike/ui',
        replacement: path.resolve(__dirname, '../../packages/ui/src'),
      },
      {
        find: '@brainstrike/platform-utils',
        replacement: path.resolve(__dirname, '../../packages/platform-utils/src'),
      },
      {
        find: '@brainstrike/app-shell',
        replacement: path.resolve(__dirname, '../../packages/app-shell/src'),
      },
      {
        find: '@brainstrike/db-explorer',
        replacement: path.resolve(__dirname, '../../packages/db-explorer/src'),
      },
      {
        find: '@brainstrike/embedding-worker',
        replacement: path.resolve(__dirname, '../../packages/embedding-worker/src'),
      },
      {
        find: '@brainstrike/embeddings',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src'),
      },
      {
        find: '@brainstrike/worker-runtime',
        replacement: path.resolve(__dirname, '../../packages/worker-runtime/src'),
      },
      {
        find: '@brainstrike/queue/browser',
        replacement: path.resolve(__dirname, '../../packages/queue/src/browser.ts'),
      },
      {
        find: '@brainstrike/queue',
        replacement: path.resolve(__dirname, '../../packages/queue/src'),
      },
      {
        find: '@brainstrike/file-import/browser-queue-port',
        replacement: path.resolve(
          __dirname,
          '../../packages/file-import/src/browser-queue-port.ts'
        ),
      },
      {
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: path.resolve(
          __dirname,
          '../../packages/file-import/src/chunking-worker-context.tsx'
        ),
      },
      {
        find: '@brainstrike/file-import/enhanced-import',
        replacement: path.resolve(__dirname, '../../packages/file-import/src/enhanced-import.ts'),
      },
      {
        find: '@brainstrike/file-import',
        replacement: path.resolve(__dirname, '../../packages/file-import/src'),
      },
      {
        find: '@brainstrike/chunking-worker',
        replacement: path.resolve(__dirname, '../../packages/chunking-worker/src'),
      },
      {
        find: '@brainstrike/preferences',
        replacement: path.resolve(__dirname, '../../packages/preferences/src'),
      },
      {
        find: '@brainstrike/text-splitter',
        replacement: path.resolve(__dirname, '../../packages/text-splitter/src'),
      },
      {
        find: '@brainstrike/storage/electron',
        replacement: path.resolve(__dirname, '../../packages/storage/src/electron.ts'),
      },
      {
        find: '@brainstrike/storage',
        replacement: path.resolve(__dirname, '../../packages/storage/src'),
      },
      {
        find: '@brainstrike/file-system/path-validation',
        replacement: path.resolve(__dirname, '../../packages/file-system/src/path-validation.ts'),
      },
      {
        find: '@brainstrike/file-system/electron',
        replacement: path.resolve(__dirname, '../../packages/file-system/src/electron.ts'),
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
        find: '@brainstrike/vector-management',
        replacement: path.resolve(__dirname, '../../packages/vector-management/src'),
      },
      {
        // Force pino to browser build to avoid dynamic require of node libs in renderer
        find: 'pino',
        replacement: pinoBrowserPath,
      },
      {
        find: 'pino/browser.js',
        replacement: pinoBrowserPath,
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
    entries: [...getLazySurfaceOptimizeDepsEntries(__dirname)],
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
    include: ['react-helmet-async'],
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
