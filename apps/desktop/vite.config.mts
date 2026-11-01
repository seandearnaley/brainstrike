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
    // Just above the measured largest chunk (main, about 3,080 kB) so any
    // growth warns. Diff views load with their first use; the 2.3 MB o200k
    // table is fetched as an asset only on accurate-token use.
    chunkSizeWarningLimit: 3100,
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
      '@brainstrike/file-explorer-hooks/file-content-worker',
      '@brainstrike/file-explorer-ui',
      '@brainstrike/file-tree-worker',
      '@brainstrike/file-system',
      '@brainstrike/storage',
      '@brainstrike/app-shell',
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
    alias: [
      // Workspace packages resolve through their `exports`. vite.ts is file-tree-worker's
      // Vite worker-URL entry; its root export is the Node-side one.
      {
        find: '@brainstrike/file-tree-worker',
        replacement: path.resolve(__dirname, '../../packages/file-tree-worker/src/vite.ts'),
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
    // CRITICAL: keep the desktop renderer dev URL deterministic: a fixed port with
    // strictPort, so Electron never loads a dev server on a fallback port.
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
