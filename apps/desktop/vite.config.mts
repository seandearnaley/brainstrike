import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserBareDynamicImportGuardPlugin,
  buildIdPlugin,
  createCspQualifiedEvalWarningFilter,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getLazySurfaceOptimizeDepsEntries,
  getTreeSitterGrammarCopyTargets,
  getWorkspaceSourceOptimizeDepsInclude,
  isContextActionSystemModule,
  isSanitizedPersistMergeModule,
  isZustandModule,
  preserveWorkerEntryPlugin,
} from '@brainstrike/build-utils';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import wasm from 'vite-plugin-wasm';
import { bundledPackageNotices, RENDERER_LICENSE_REPORT } from './scripts/third-party-notices.mjs';
import { getDevCSP } from './src/csp-utils';
import { DESKTOP_DEV_RENDERER_PORT } from './src/desktop-renderer-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const pinoBrowserPath = require.resolve('pino/browser.js');

const desktopPackage: { readonly version?: string } = require('./package.json');

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles.
// BST-1659: run by `oxc-transform-react` (Rust) through @vitejs/plugin-react, not Babel.
// `critical_errors` fails the transform when the compiler would silently skip a component
// or hook for an Error-level reason (refs read during render, unpreserved memoization).
// Advice-level skips (syntax it cannot lower yet, such as try/finally) still compile out.
const ReactCompilerConfig = {
  compilationMode: 'infer',
  panicThreshold: 'critical_errors',
} as const;

/**
 * `@vitejs/plugin-react` defaults to excluding `/node_modules/` alone, but `cacheDir` below
 * puts the dep-optimizer output in `apps/desktop/.vite`, OUTSIDE node_modules. Without the
 * second pattern the compiler and the Fast Refresh transform would run over pre-bundled
 * dependency chunks. This restores the exclusions the removed `@rolldown/plugin-babel` pass
 * carried.
 */
const reactTransformExclude = [/[\\/]node_modules[\\/]/u, /[\\/]\.vite[\\/]/u];

/**
 * The modules the renderer and its workers bundle, for the app's license
 * notices (BST-2358, scripts/third-party-notices.mjs). Vite bundles a worker
 * while it transforms the module that starts it, so every worker's modules are
 * collected before the renderer bundle is generated and the report written.
 */
const rendererModuleIds = new Set<string>();
function rendererLicenseReport({ write }: { readonly write: boolean }): Plugin {
  return {
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const moduleId of output.moduleIds) {
            rendererModuleIds.add(moduleId);
          }
        }
      }
      if (write) {
        this.emitFile({
          fileName: RENDERER_LICENSE_REPORT,
          source: `${JSON.stringify(bundledPackageNotices(rendererModuleIds), null, 2)}\n`,
          type: 'asset',
        });
      }
    },
    name: 'brainstrike:renderer-license-report',
  };
}

export default defineConfig({
  base: './', // Use relative paths for Electron
  build: {
    assetsInlineLimit: 0,
    // Accept the measured renderer/main, context-preview and bootstrap
    // chunks while retaining a useful regression ceiling.
    // The 2.3 MB o200k table is fetched as an asset only on accurate-token use.
    chunkSizeWarningLimit: 1300,
    emptyOutDir: true,
    outDir: 'dist/renderer',
    rolldownOptions: {
      external: ['electron', '@mastra/core', /^@mastra\//u],
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
                // splitting so dynamically-imported vendors (pele, shiki,
                // katex, codemirror, …) stay OFF the startup critical path.
                if (isZustandModule(moduleId)) {
                  return 'zustand';
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
    // The renderer has no Node process. Dependencies read `process.env` (assistant-ui's cloud
    // base URL); the dev client must expose the same empty object a production build inlines.
    'process.env': '{}',
    // Retained from the PGlite removal; not proven unneeded by other renderer dependencies.
    'process.versions': 'undefined',
  },
  optimizeDeps: {
    entries: [...getLazySurfaceOptimizeDepsEntries(__dirname)],
    exclude: [
      '@brainstrike/types',
      '@brainstrike/hooks',
      '@brainstrike/assistant-ui',
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/file-explorer',
      '@brainstrike/file-explorer-hooks',
      '@brainstrike/file-explorer-ui',
      '@brainstrike/file-tree-worker',
      '@brainstrike/file-system',
      '@brainstrike/storage',
      '@brainstrike/app-shell',
      '@brainstrike/workers',
      '@brainstrike/token-cache',
      '@brainstrike/token-cache/cache-runtime',
      '@brainstrike/token-cache/background-indexer',
    ],
    include: [
      ...getCoreAppOptimizeDepsInclude(),
      ...getAssistantOptimizeDepsInclude(),
      ...getWorkspaceSourceOptimizeDepsInclude(),
    ],
  },
  plugins: [
    // A bare dynamic import fails in the renderer at runtime, never at build (BST-2230).
    browserBareDynamicImportGuardPlugin(),
    // __BRAINSTRIKE_BUILD_ID__: the packaged app is one build per version.
    buildIdPlugin([
      { name: 'apps/desktop/package.json version', read: () => desktopPackage.version },
    ]),
    fullReloadOnCompilerHotspots(),
    rendererLicenseReport({ write: true }),
    wasm(),
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
        find: '@brainstrike/file-explorer-ui/styles.css',
        replacement: path.resolve(__dirname, '../../packages/file-explorer-ui/styles.css'),
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
      {
        // Force pino to browser build to avoid dynamic require of node libs in renderer
        find: 'pino',
        replacement: pinoBrowserPath,
      },
      {
        find: 'pino/browser.js',
        replacement: pinoBrowserPath,
      },
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
    plugins: () => [
      preserveWorkerEntryPlugin(),
      wasm(),
      browserBareDynamicImportGuardPlugin(),
      rendererLicenseReport({ write: false }),
    ],
  },
});
