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
  getTreeSitterGrammarCopyTargets,
  getWorkerpoolBrowserStubAliases,
  isBrowserEventsModule,
  isContextActionSystemModule,
  isZustandModule,
} from '@brainstrike/build-utils';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
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

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' } as const;
const reactCompilerBabelPreset = reactCompilerPreset(ReactCompilerConfig);

export default defineConfig({
  base: './', // Use relative paths for Electron
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    outDir: 'dist/renderer',
    rolldownOptions: {
      external: ['electron', '@mastra/core', /^@mastra\//],
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
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
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/utils/workspace-indexing-qos',
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
    ],
  },
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
    viteStaticCopy({
      targets: [
        // PGlite WASM (existing).
        ...(wasmPath ? [{ dest: 'assets', src: wasmPath }] : []),
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
    plugins: () => [wasm(), topLevelAwait()],
  },
});
