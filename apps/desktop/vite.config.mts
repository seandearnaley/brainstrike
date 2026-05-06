import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getLazySurfaceOptimizeDepsEntries,
  getWorkerpoolBrowserStubAliases,
  resolveAssistantVendorChunk,
} from '@brainstrike/build-utils';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { createAgentBrowserSafeAliasEntries } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
import { getDevCSP } from './src/csp-utils';
import { DESKTOP_DEV_RENDERER_PORT } from './src/desktop-renderer-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pinoBrowserPath = require.resolve('pino/browser.js');
const workerpoolBrowserStubAliases = getWorkerpoolBrowserStubAliases(__dirname);

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
const ReactCompilerConfig = { compilationMode: 'infer' } as const;
const reactCompilerBabelPreset = reactCompilerPreset(ReactCompilerConfig);

export default defineConfig({
  root: __dirname,
  base: './', // Use relative paths for Electron
  cacheDir: path.resolve(__dirname, '.vite'),
  plugins: [
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      jsxRuntime: 'automatic',
    }),
    babel({
      exclude: [/[\\/]\.vite[\\/]/, /[\\/]node_modules[\\/]/],
      presets: [reactCompilerBabelPreset],
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
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      external: ['electron', 'chokidar', '@mastra/core', /^@mastra\//],
      output: {
        codeSplitting: {
          groups: [
            {
              name(moduleId: string): string | null {
                return resolveVendorChunk(moduleId) ?? null;
              },
            },
          ],
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
      {
        find: '@brainstrike/vector-management/styles.css',
        replacement: path.resolve(__dirname, '../../packages/vector-management/styles.css'),
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
      // Resolve dev/runtime imports from source so Vite never depends on workspace dist churn.
      {
        find: '@brainstrike/token-cache/cache-runtime',
        replacement: path.resolve(__dirname, '../../packages/token-cache/src/cache-runtime.ts'),
      },
      {
        find: '@brainstrike/token-cache/background-indexer',
        replacement: path.resolve(
          __dirname,
          '../../packages/token-cache/src/background-indexer.ts'
        ),
      },
      {
        find: '@brainstrike/selection-rules',
        replacement: path.resolve(__dirname, '../../packages/selection-rules/src/index.ts'),
      },
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
        find: '@brainstrike/embeddings/runtime-config',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/runtime-config.ts'),
      },
      {
        find: '@brainstrike/embeddings/provider-core',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/provider-core.ts'),
      },
      {
        find: '@brainstrike/embeddings/backend',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/backend-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/factory',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/factory-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/service',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/service-entry.ts'),
      },
      {
        find: '@brainstrike/embeddings/worker',
        replacement: path.resolve(__dirname, '../../packages/embeddings/src/worker-entry.ts'),
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
        find: '@brainstrike/text-splitter/chunking-core',
        replacement: path.resolve(__dirname, '../../packages/text-splitter/src/chunking-core.ts'),
      },
      {
        find: '@brainstrike/text-splitter',
        replacement: path.resolve(__dirname, '../../packages/text-splitter/src/index.ts'),
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
      ...Object.entries(workerpoolBrowserStubAliases).map(([find, replacement]) => ({
        find,
        replacement,
      })),
      {
        // Force pino to browser build to avoid dynamic require of node libs in renderer
        find: 'pino',
        replacement: pinoBrowserPath,
      },
      {
        find: 'pino/browser.js',
        replacement: pinoBrowserPath,
      },
      // Agent browser-safe subpath exports (no Mastra dependencies)
      ...createAgentBrowserSafeAliasEntries(path.resolve(__dirname, '../../packages/agent')),
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
      ...getHeavyRuntimeOptimizeDepsExclude(),
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
      '@brainstrike/embeddings', // Pulls embedding-worker and transformers through source aliases
      '@brainstrike/embedding-worker', // Keep Vite out of the raw worker/runtime graph
      '@brainstrike/db-explorer', // Uses file-import which has worker
      '@brainstrike/file-import', // Contains useChunkingWorker hook - must not be pre-bundled
      '@brainstrike/token-cache',
      '@brainstrike/token-cache/cache-runtime',
      '@brainstrike/token-cache/background-indexer',
      '@brainstrike/chunking-worker', // Worker must resolve via package exports (dist)
    ],
    include: [
      ...getCoreAppOptimizeDepsInclude(),
      ...getAssistantOptimizeDepsInclude(),
      ...getDatabaseOptimizeDepsInclude(),
    ],
  },
  define: {
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(process.env.EMBED_QUEUE_ENABLED ?? 'true'),
    // Force PGlite to resolve browser implementation in renderer
    'process.versions': 'undefined',
  },
  server: {
    // CRITICAL: keep desktop renderer dev URL deterministic and isolated from the
    // web app's default/fallback dev-server ports. Repo-root `pnpm run dev` starts
    // both apps, so desktop must not share the web port neighborhood.
    port: DESKTOP_DEV_RENDERER_PORT,
    strictPort: true,
    warmup: {
      clientFiles: ['./src/renderer/main.tsx'],
    },
    headers: {
      'Content-Security-Policy': getDevCSP(),
    },
  },
  publicDir: 'public',
});
