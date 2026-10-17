import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIdPlugin,
  createCspQualifiedEvalWarningFilter,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getLazySurfaceOptimizeDepsEntries,
  getTreeSitterGrammarCopyTargets,
  getWorkerpoolBrowserStubAliases,
  getWorkspaceSourceOptimizeDepsInclude,
  isBrowserEventsModule,
  isContextActionSystemModule,
  isSanitizedPersistMergeModule,
  isZustandModule,
  preserveWorkerEntryPlugin,
  transformersOnnxRuntimeWasmUrlsPlugin,
} from '@brainstrike/build-utils';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { createAgentBrowserSafeAliasEntries } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
import { getDevCSP } from './src/csp-utils';
import { rendererIsolationHeaders } from './src/desktop-renderer-target';
import { DESKTOP_DEV_RENDERER_PORT } from './src/desktop-renderer-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The dev server applies the built protocol's cross-origin isolation policy (BST-1999). */
function rendererIsolationPlugin(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://renderer.invalid');
        for (const [name, value] of Object.entries(
          rendererIsolationHeaders(url, ['/', '/index.html'])
        )) {
          response.setHeader(name, value);
        }
        next();
      });
    },
    name: 'brainstrike-renderer-isolation',
  };
}
const require = createRequire(import.meta.url);
const pinoBrowserPath = require.resolve('pino/browser.js');
const workerpoolBrowserStubAliases = getWorkerpoolBrowserStubAliases(__dirname);

const desktopPackage: { readonly version?: string } = require('./package.json');

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles.
// BST-1659: run by `oxc-transform-react` (Rust) through @vitejs/plugin-react, not Babel.
const ReactCompilerConfig = { compilationMode: 'infer' } as const;

/**
 * `@vitejs/plugin-react` defaults to excluding `/node_modules/` alone, but `cacheDir` below
 * puts the dep-optimizer output in `apps/desktop/.vite`, OUTSIDE node_modules. Without the
 * second pattern the compiler and the Fast Refresh transform would run over pre-bundled
 * dependency chunks. This restores the exclusions the removed `@rolldown/plugin-babel` pass
 * carried.
 */
const reactTransformExclude = [/[\\/]node_modules[\\/]/, /[\\/]\.vite[\\/]/];

export default defineConfig({
  base: './', // Use relative paths for Electron
  build: {
    assetsInlineLimit: 0,
    // Accept the measured renderer/main, context-preview, bootstrap, PGlite,
    // and Transformers chunks while retaining a useful regression ceiling.
    // The 2.3 MB o200k table is fetched as an asset only on accurate-token use.
    chunkSizeWarningLimit: 1300,
    emptyOutDir: true,
    outDir: 'dist/renderer',
    rolldownOptions: {
      external: ['electron', '@mastra/core', /^@mastra\//],
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      onLog: createCspQualifiedEvalWarningFilter(),
      output: {
        codeSplitting: {
          groups: [
            {
              name(moduleId: string): string | null {
                // Co-locate the context-action/command system (chunk-init TDZ
                // guard — see isContextActionSystemModule in build-utils).
                // Everything else uses rolldown's default reachability-based
                // splitting so dynamically-imported vendors (mermaid, shiki,
                // katex, codemirror, …) stay OFF the startup critical path.
                if (isZustandModule(moduleId)) {
                  return 'zustand';
                }
                if (isBrowserEventsModule(moduleId)) {
                  return 'browser-events';
                }
                if (isSanitizedPersistMergeModule(moduleId)) {
                  return 'sanitized-persist-merge';
                }
                return isContextActionSystemModule(moduleId) ? 'context-action-system' : null;
              },
            },
          ],
        },
      },
    },
    target: 'esnext',
  },
  cacheDir: path.resolve(__dirname, '.vite'),
  define: {
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(process.env.EMBED_QUEUE_ENABLED ?? 'true'),
    // Force PGlite to resolve browser implementation in renderer
    'process.versions': 'undefined',
  },
  optimizeDeps: {
    entries: [...getLazySurfaceOptimizeDepsEntries(__dirname)],
    exclude: [
      ...getHeavyRuntimeOptimizeDepsExclude(),
      '@electric-sql/pglite',
      // Split pgvector/pg_textsearch packages ship their WASM/tar via import.meta.url;
      // prebundling into .vite/deps breaks that relative asset URL, so exclude like core PGlite.
      '@electric-sql/pglite-pgvector',
      '@electric-sql/pglite-pg_textsearch',
      '@brainstrike/types',
      '@brainstrike/hooks',
      '@brainstrike/assistant-ui',
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/indexing-contract/workspace-indexing-qos',
      '@brainstrike/file-explorer',
      '@brainstrike/file-explorer-hooks',
      '@brainstrike/file-explorer-ui',
      '@brainstrike/file-tree-worker',
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
      ...getWorkspaceSourceOptimizeDepsInclude(),
      // Imported by @brainstrike/chunking-worker, excluded above, which src/renderer/main.tsx
      // imports. The scan never crawls an excluded package, so a cold server met these only
      // after its crawl, re-optimized and reloaded the renderer mid-launch (BST-2091).
      '@brainstrike/chunking-worker > @babel/parser',
      '@brainstrike/chunking-worker > web-tree-sitter',
    ],
  },
  plugins: [
    rendererIsolationPlugin(),
    // ONNX Runtime's WASM, emitted from the onnxruntime-web Transformers.js itself depends
    // on, for both realms that run it: the embedding worker and the local-model host
    // (BST-2003).
    transformersOnnxRuntimeWasmUrlsPlugin([
      path.resolve(__dirname, '../../packages/embedding-worker'),
      path.resolve(__dirname, '../../packages/agent'),
    ]),
    // __BRAINSTRIKE_BUILD_ID__: the packaged app is one build per version.
    buildIdPlugin([
      { name: 'apps/desktop/package.json version', read: () => desktopPackage.version },
    ]),
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      compiler: ReactCompilerConfig,
      exclude: reactTransformExclude,
      jsxRuntime: 'automatic',
    }),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        // Tree-sitter grammar files (Phase 4 of #998). Vendored under
        // packages/chunking-worker/grammars/, copied to dist/renderer/
        // assets/grammars/. The chunking worker fetches them at runtime
        // via `fetch('/assets/grammars/<lang>.wasm')`.
        ...getTreeSitterGrammarCopyTargets(__dirname),
      ],
    }),
  ],
  publicDir: 'public',
  resolve: {
    // Array form: first match wins, so deliberate overrides/exceptions come
    // BEFORE the shared registry spread (B3/B4 convention, #1651/#1658). Every
    // root/subpath alias the registry emits is an EXACT specifier match
    // (derived from each package's own `exports` map), so — unlike the old
    // hand-maintained list's mix of exact AND blanket string-prefix roots
    // (e.g. the `@brainstrike/utils` exact+prefix pair this replaces) —
    // subpath vs. root ordering can no longer shadow anything; only the
    // exceptions below need to precede it.
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Stylesheet/asset imports: the registry deliberately excludes non-code
      // exports (css/json/icons), so these stay explicit.
      {
        find: '@brainstrike/app-shell/styles.css',
        replacement: path.resolve(__dirname, '../../packages/app-shell/styles.css'),
      },
      {
        find: '@brainstrike/workspace-search/styles.css',
        replacement: path.resolve(__dirname, '../../packages/workspace-search/styles.css'),
      },
      {
        find: '@brainstrike/db-explorer/styles.css',
        replacement: path.resolve(__dirname, '../../packages/db-explorer/styles.css'),
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
        find: '@brainstrike/assistant-ui/styles.css',
        replacement: path.resolve(__dirname, '../../packages/assistant-ui/styles.css'),
      },
      {
        find: '@brainstrike/ui/globals.css',
        replacement: path.resolve(__dirname, '../../packages/ui/src/globals.css'),
      },
      // @brainstrike/file-tree-worker's root `exports['.']` targets a
      // Node-worker_threads entry (dist/index.js); the registry would derive
      // that same Node-targeted src/index.ts. vite.ts is the deliberate
      // browser-adapted implementation (Vite Worker URL syntax) this app
      // needs instead, so it must precede the spread.
      {
        find: '@brainstrike/file-tree-worker',
        replacement: path.resolve(__dirname, '../../packages/file-tree-worker/src/vite.ts'),
      },
      // @brainstrike/workers has no `src/` dir (worker files live at the
      // package root), so the registry skips it — alias explicitly.
      {
        find: '@brainstrike/workers',
        replacement: path.resolve(__dirname, '../../packages/workers'),
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
      // Agent browser-safe subpath exports (no Mastra dependencies). The
      // registry EXCLUDES @brainstrike/agent's root by default
      // (DEFAULT_SRC_ALIAS_EXCLUSIONS) — this app's renderer bundle only ever
      // needs these browser-safe subpaths, so no root override is added here.
      ...createAgentBrowserSafeAliasEntries(path.resolve(__dirname, '../../packages/agent')),
      // Force PGlite to use browser FS implementation in renderer to avoid node:fs imports
      {
        find: /@electric-sql\/pglite\/dist\/fs\/nodefs\.js$/,
        replacement: '@electric-sql/pglite/dist/fs/opfs-ahp.js',
      },
      // Fallback for relative import inside pglite dist
      { find: './fs/nodefs.js', replacement: './fs/opfs-ahp.js' },
      // B3/B4: shared workspace source-alias registry (#1651/#1658). Replaces
      // the hand-maintained map this file used to carry — every entry it
      // listed besides the exceptions above (including the chunk-init-TDZ
      // motivated commands/context-actions entries and the renamed
      // db-explorer/embedding-models subpath) is an exact match for what this
      // registry derives from each package's own `exports` map.
      ...workspaceSrcAliases(path.resolve(__dirname, '../../packages')),
    ],
    dedupe: ['react', 'react-dom'],
  },
  root: __dirname,
  server: {
    headers: {
      'Content-Security-Policy': getDevCSP(),
    },
    // CRITICAL: keep desktop renderer dev URL deterministic and isolated from the
    // web app's default/fallback dev-server ports. Repo-root `pnpm run dev` starts
    // both apps, so desktop must not share the web port neighborhood.
    port: DESKTOP_DEV_RENDERER_PORT,
    strictPort: true,
    warmup: {
      clientFiles: ['./src/renderer/main.tsx'],
    },
  },
  worker: {
    format: 'es',
    plugins: () => [preserveWorkerEntryPlugin(), wasm(), topLevelAwait()],
  },
});
