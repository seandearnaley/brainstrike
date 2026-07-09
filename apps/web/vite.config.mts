import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@brainstrike/utils';
import { codecovVitePlugin } from '@codecov/vite-plugin';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
/// <reference types="vitest" />
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasMap } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
import { getDevCSP } from './src/csp-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pinoBrowserPath = require.resolve('pino/browser.js');
const viteLogger = createLogger('WebViteConfig');

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' } as const;

// Keep config concise; avoid noisy debug printing in dev

// The Tailwind CSS content paths are now managed by `tailwind.config.js`.
// The @tailwindcss/vite plugin will automatically pick it up.

const {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getLazySurfaceOptimizeDepsEntries,
  getTreeSitterGrammarCopyTargets,
  getWorkerpoolBrowserStubAliases,
  resolveAssistantVendorChunk,
} = await import('@brainstrike/build-utils');
const reactCompilerBabelPreset = reactCompilerPreset(ReactCompilerConfig);
const wasmPath = findPGliteWasm(__dirname);
const workerpoolBrowserStubAliases = getWorkerpoolBrowserStubAliases(__dirname);

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

/**
 * Co-locate the whole context-action / command system into ONE chunk.
 *
 * `defineContextAction` (packages/context-actions) and `defineCommand`
 * (packages/commands) are pure identity helpers, but the feature
 * `*​/context-actions` modules CALL them at MODULE-INIT to build their action
 * arrays (e.g. `const actions = [defineContextAction({ id: 'file.copy-name' })]`).
 * Rolldown's default chunking hoists the shared helper into its own chunk,
 * separate from its eager callers; the caller chunk then runs `helper(...)` at
 * init before the helper chunk has initialized → a circular chunk-init TDZ
 * ("k is not a function") that leaves the BUILT renderer with an empty #root on
 * startup. Dev is unaffected (Vite serves unbundled ESM, native init order); the
 * DESKTOP renderer is unaffected (its bundle already co-locates them). Forcing a
 * single chunk here removes the cross-chunk init-order hazard on web. Source
 * aliasing alone (below) does NOT fix it — rolldown still splits the shared
 * helper out for dedup. Do NOT remove without re-verifying the built web app
 * mounts (apps/web/e2e @web-smoke).
 */
function isContextActionSystemModule(id: string): boolean {
  if (id.includes('node_modules')) {
    return false;
  }
  // Matches the core package (…/context-actions/src/…), every feature
  // …/src/context-actions/… module that calls defineContextAction at init, and
  // the commands registry that shares the same define-at-init pattern.
  return /[\\/]context-actions[\\/]/.test(id) || /[\\/]packages[\\/]commands[\\/]/.test(id);
}

const WORKER_PROCESS_EXIT_CODE_BINDING = '__brainstrikeWorkerProcessExitCode';

function browserWorkerProcessExitCodePlugin() {
  return {
    enforce: 'post' as const,
    name: 'brainstrike-browser-worker-process-exit-code',
    transform(code: string) {
      if (!code.includes('process.exitCode')) {
        return null;
      }

      return {
        code: `let ${WORKER_PROCESS_EXIT_CODE_BINDING};\n${code.replaceAll(
          'process.exitCode',
          WORKER_PROCESS_EXIT_CODE_BINDING
        )}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  assetsInclude: ['**/*.png'],
  build: {
    assetsDir: 'assets', // Directory for static assets within the build output
    assetsInlineLimit: 0,
    minify: 'terser', // Use terser for better minification
    outDir: 'dist', // Output directory for the build - cache bust
    rolldownOptions: {
      external: ['electron', 'chokidar', '@mastra/core', /^@mastra\//],
      output: {
        codeSplitting: {
          groups: [
            {
              name(moduleId: string): string | null {
                // Co-locate the context-action/command system first (prevents the
                // circular chunk-init TDZ that blanks #root in the built renderer),
                // then fall back to vendor chunking for node_modules.
                if (isContextActionSystemModule(moduleId)) {
                  return 'context-action-system';
                }
                return resolveVendorChunk(moduleId) ?? null;
              },
            },
          ],
        },
      },
    },
    sourcemap: false, // Disable sourcemaps for production build
    target: 'es2020',
    terserOptions: {
      // biome-ignore lint/style/useNamingConvention: required for terser drop_console target
      compress: { drop_console: false },
    },
  },
  cacheDir: path.resolve(__dirname, '.vite'),
  define: {
    'process.browser': true,
    'process.env': {},
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(
      process.env['EMBED_QUEUE_ENABLED'] ?? 'false'
    ),
    'process.env.LOCAL_FIRST_DB': JSON.stringify(
      process.env['LOCAL_FIRST_DB'] ?? process.env['EMBED_QUEUE_ENABLED'] ?? 'false'
    ),
    'process.platform': '"browser"',
    // Browser-only shim that tracks the repo Node target for dependencies probing process.version.
    'process.version': '"v24.0.0"',
  },
  optimizeDeps: {
    entries: [...getLazySurfaceOptimizeDepsEntries(__dirname)],
    exclude: [
      ...getHeavyRuntimeOptimizeDepsExclude(),
      '@electric-sql/pglite', // Official PGlite requirement
      // Split pgvector package ships its WASM/tar via import.meta.url; prebundling
      // into .vite/deps breaks that relative asset URL, so exclude like core PGlite.
      '@electric-sql/pglite-pgvector',
      '@brainstrike/types',
      '@brainstrike/hooks',
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
      '@brainstrike/embeddings', // Pulls embedding-worker and transformers through source aliases
      '@brainstrike/embedding-worker', // Keep Vite out of the raw worker/runtime graph
      '@brainstrike/db-explorer', // Uses file-import which has worker
      '@brainstrike/file-import', // Contains useChunkingWorker hook - must not be pre-bundled
      '@brainstrike/token-cache',
      '@brainstrike/token-cache/cache-runtime',
      '@brainstrike/token-cache/background-indexer',
    ],
    include: [
      ...getCoreAppOptimizeDepsInclude(),
      ...getAssistantOptimizeDepsInclude(),
      ...getDatabaseOptimizeDepsInclude(),
    ],
    rolldownOptions: {
      transform: {
        define: {
          global: 'globalThis',
        },
      },
    },
  },
  plugins: [
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      // Ensure consistent development transforms for React Compiler
      jsxRuntime: 'automatic',
    }),
    babel({
      exclude: [/[\\/]\.vite[\\/]/, /[\\/]node_modules[\\/]/],
      presets: [reactCompilerBabelPreset],
    }),
    tailwindcss(), // Automatically finds and uses the root tailwind.config.js
    viteStaticCopy({
      targets: [
        // PGlite WASM (existing). Conditionally included via spread so the
        // build doesn't fail when pglite isn't yet built.
        ...(wasmPath ? [{ dest: 'assets', src: wasmPath }] : []),
        // Tree-sitter grammar files (Phase 4 of #998). Vendored under
        // packages/chunking-worker/grammars/, copied to dist/assets/grammars/.
        // The chunking worker fetches them at runtime via
        // `fetch('/assets/grammars/<lang>.wasm')`.
        ...getTreeSitterGrammarCopyTargets(__dirname),
      ],
    }),
    // Conditionally configure Codecov plugin
    ...(process.env['CODECOV_TOKEN']
      ? [
          codecovVitePlugin({
            bundleName: 'brainstrike-web-bundle',
            enableBundleAnalysis: true,
            uploadToken: process.env['CODECOV_TOKEN'],
          }),
        ]
      : []), // If no token, don't include the plugin config
    // Dev/preview middleware for /api/chat to support E2E and local dev
    devChatApiPlugin(),
    devHfProxyPlugin(),
  ],
  resolve: {
    // biome-ignore assist/source/useSortedKeys: Vite object aliases are order-sensitive; subpath aliases must precede package-root aliases.
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Map stylesheet imports to source files for consistent theme loading
      '@brainstrike/app-shell/styles.css': path.resolve(
        __dirname,
        '../../packages/app-shell/styles.css'
      ),
      '@brainstrike/db-explorer/styles.css': path.resolve(
        __dirname,
        '../../packages/db-explorer/styles.css'
      ),
      '@brainstrike/workspace-search/styles.css': path.resolve(
        __dirname,
        '../../packages/workspace-search/styles.css'
      ),
      '@brainstrike/app-shell': path.resolve(__dirname, '../../packages/app-shell/src'),
      '@brainstrike/chunking-worker': path.resolve(__dirname, '../../packages/chunking-worker/src'),
      // Source-alias like every other @brainstrike package. Resolving these to
      // their built `dist` lands `defineContextAction` in a separate chunk from
      // the source feature `*/context-actions` that call it at module-init →
      // circular chunk-init TDZ ("t is not a function") that hangs the BUILT
      // renderer on startup (dev is unaffected). See the vite-alias coverage test.
      '@brainstrike/commands': path.resolve(__dirname, '../../packages/commands/src'),
      '@brainstrike/context-actions': path.resolve(__dirname, '../../packages/context-actions/src'),
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      // Subpath alias must precede the package-root alias: the `./embedding-models`
      // export maps to `src/utils/embedding-models.ts`, but the prefix-replacing
      // root alias would resolve it to the non-existent `src/embedding-models`.
      '@brainstrike/db-explorer/embedding-models': path.resolve(
        __dirname,
        '../../packages/db-explorer/src/utils/embedding-models.ts'
      ),
      '@brainstrike/db-explorer': path.resolve(__dirname, '../../packages/db-explorer/src'),
      '@brainstrike/embedding-worker': path.resolve(
        __dirname,
        '../../packages/embedding-worker/src'
      ),
      '@brainstrike/embeddings/backend': path.resolve(
        __dirname,
        '../../packages/embeddings/src/backend-entry.ts'
      ),
      '@brainstrike/embeddings/factory': path.resolve(
        __dirname,
        '../../packages/embeddings/src/factory-entry.ts'
      ),
      '@brainstrike/embeddings/provider-core': path.resolve(
        __dirname,
        '../../packages/embeddings/src/provider-core.ts'
      ),
      '@brainstrike/embeddings/runtime-config': path.resolve(
        __dirname,
        '../../packages/embeddings/src/runtime-config.ts'
      ),
      '@brainstrike/embeddings/service': path.resolve(
        __dirname,
        '../../packages/embeddings/src/service-entry.ts'
      ),
      '@brainstrike/embeddings/worker': path.resolve(
        __dirname,
        '../../packages/embeddings/src/worker-entry.ts'
      ),
      '@brainstrike/embeddings': path.resolve(__dirname, '../../packages/embeddings/src'),
      // NOTE: @brainstrike/file-explorer must alias to DIST (not src) so the worker-storage.worker.js
      // file is properly bundled. Aliasing to src causes the .ts worker file to be emitted without
      // transformation, which browsers cannot execute.
      // The web:dev script has a predev step that ensures file-explorer is built first.
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/dist'),
      // Ensure hooks resolve to source once to avoid duplicates
      '@brainstrike/file-explorer-hooks': path.resolve(
        __dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/file-explorer-ui/styles.css': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/styles.css'
      ),
      // Source alias to ensure consistent React Compiler transforms and HMR
      '@brainstrike/file-explorer-ui': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/src'
      ),
      '@brainstrike/file-import/browser-queue-port': path.resolve(
        __dirname,
        '../../packages/file-import/src/browser-queue-port.ts'
      ),
      '@brainstrike/file-import/chunking-worker-context': path.resolve(
        __dirname,
        '../../packages/file-import/src/chunking-worker-context.tsx'
      ),
      '@brainstrike/file-import/enhanced-import': path.resolve(
        __dirname,
        '../../packages/file-import/src/enhanced-import.ts'
      ),
      '@brainstrike/file-import': path.resolve(__dirname, '../../packages/file-import/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../../packages/file-system/src'),
      // NOTE: Do NOT alias @brainstrike/agent to source - server-side routes need the
      // full package which has Node.js dependencies. Only the /client subpath is browser-safe.
      // '@brainstrike/agent': path.resolve(__dirname, '../../packages/agent/src'),
      // Resolve dev/runtime imports from source so Vite never depends on workspace dist churn.
      '@brainstrike/file-tree-worker': path.resolve(
        __dirname,
        '../../packages/file-tree-worker/src/vite.ts'
      ),
      '@brainstrike/platform-utils': path.resolve(__dirname, '../../packages/platform-utils/src'),
      '@brainstrike/preferences': path.resolve(__dirname, '../../packages/preferences/src'),
      '@brainstrike/queue/browser': path.resolve(__dirname, '../../packages/queue/src/browser.ts'),
      '@brainstrike/queue': path.resolve(__dirname, '../../packages/queue/src'),
      '@brainstrike/selection-rules': path.resolve(
        __dirname,
        '../../packages/selection-rules/src/index.ts'
      ),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@brainstrike/text-splitter/chunking-core': path.resolve(
        __dirname,
        '../../packages/text-splitter/src/chunking-core.ts'
      ),
      '@brainstrike/text-splitter/token-constants': path.resolve(
        __dirname,
        '../../packages/text-splitter/src/token-constants.ts'
      ),
      '@brainstrike/text-splitter/token-counting-heuristics': path.resolve(
        __dirname,
        '../../packages/text-splitter/src/token-counting-heuristics.ts'
      ),
      '@brainstrike/text-splitter/token-utils-accurate-lite': path.resolve(
        __dirname,
        '../../packages/text-splitter/src/token-utils-accurate-lite.ts'
      ),
      '@brainstrike/text-splitter': path.resolve(
        __dirname,
        '../../packages/text-splitter/src/index.ts'
      ),
      '@brainstrike/token-cache/background-indexer': path.resolve(
        __dirname,
        '../../packages/token-cache/src/background-indexer.ts'
      ),
      '@brainstrike/token-cache/cache-runtime': path.resolve(
        __dirname,
        '../../packages/token-cache/src/cache-runtime.ts'
      ),
      '@brainstrike/types': path.resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/ui/globals.css': path.resolve(__dirname, '../../packages/ui/src/globals.css'),
      '@brainstrike/ui/styles.css': path.resolve(__dirname, '../../packages/ui/styles.css'),
      '@brainstrike/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/vector-management/styles.css': path.resolve(
        __dirname,
        '../../packages/vector-management/styles.css'
      ),
      '@brainstrike/vector-management': path.resolve(
        __dirname,
        '../../packages/vector-management/src'
      ),
      '@brainstrike/worker-runtime': path.resolve(__dirname, '../../packages/worker-runtime/src'),
      '@brainstrike/workers': path.resolve(__dirname, '../../packages/workers'),
      src: path.resolve(__dirname, './src'),
      ...workerpoolBrowserStubAliases,
      // Force pino to browser build to avoid dynamic require of node libs
      pino: pinoBrowserPath,
      'pino/browser.js': pinoBrowserPath,
      // Agent browser-safe subpath exports (no Mastra dependencies)
      ...createAgentBrowserSafeAliasMap(path.resolve(__dirname, '../../packages/agent')),
      './fs/nodefs.js': './fs/opfs-ahp.js',
      // Force PGlite to use browser FS implementation in web renderer to avoid node:fs imports
      '@electric-sql/pglite/dist/fs/nodefs.js': '@electric-sql/pglite/dist/fs/opfs-ahp.js',
      // remove duplicate hooks alias
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    headers: {
      'Content-Security-Policy': getDevCSP(),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    host: true,
    port: 8080,
    // HuggingFace proxy is handled by devHfProxyPlugin() below instead of
    // Vite's built-in http-proxy (which cannot follow 307 redirects from HF CDN).
  },
  test: {
    coverage: {
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        '**/*.{config,config.*}',
      ],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'happy-dom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Exclude all E2E test specs - Playwright handles those
      'e2e/**/*.spec.ts',
      'e2e/**/*.test.ts',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
    globals: true,
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      // E2E utility unit tests use .vitest.ts extension to avoid Playwright extension conflict
      'e2e/utils/__tests__/**/*.vitest.ts',
    ],
    // Coverage consolidated at root vitest.config.mts
    mockReset: true,
    onConsoleLog: (log: string, type: 'stdout' | 'stderr') => {
      if (type === 'stderr' && log.includes('ERROR') && !log.includes('Error: Not implemented')) {
        return true;
      }
      return false;
    },
    reporters: ['default', 'hanging-process'],
    // Vitest 4: deps.inline moved to server.deps.inline
    server: {
      deps: {
        inline: [
          '@brainstrike/types',
          '@brainstrike/hooks',
          '@brainstrike/ui',
          '@brainstrike/utils',
        ],
      },
    },
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    silent: true,
  },
  worker: {
    format: 'es',
    plugins: () => [browserWorkerProcessExitCodePlugin()],
  },
});

// Minimal dev/preview plugin to serve /api/chat using our agent
function devChatApiPlugin() {
  return {
    async configurePreviewServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(await createApiMiddleware('preview'));
    },
    async configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(await createApiMiddleware('dev'));
    },
    name: 'dev-chat-api',
  };
}

// Dev proxy for /api/hf/* – uses fetch() (which follows 307 redirects) instead
// of Vite's built-in http-proxy (which passes redirects through to the browser,
// causing SPA fallback to serve index.html instead of model files).
function devHfProxyPlugin() {
  return {
    async configureServer(server: import('vite').ViteDevServer) {
      const { handleHfProxyRequest } = await import('./src/hf-dev-proxy.ts');
      server.middlewares.use(
        (
          req: import('http').IncomingMessage,
          res: import('http').ServerResponse,
          next: () => void
        ) => {
          if (req.url?.startsWith('/api/hf/')) {
            handleHfProxyRequest(req, res).catch((error) => {
              viteLogger.error('[dev-hf-proxy] handler error', { error });
              if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'text/plain' });
              }
              res.end('Internal proxy error');
            });
            return;
          }
          next();
        }
      );
    },
    name: 'dev-hf-proxy',
  };
}

async function createApiMiddleware(mode: 'dev' | 'preview') {
  const { readBody, handleChatEndpoint, handleAssistantEndpoint, sendAssistantStatusResponse } =
    await import('./src/assistant-stream-helpers.ts');

  return async (
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    next: () => void
  ) => {
    try {
      if (req.method === 'GET' && req.url?.startsWith('/api/assistant/status')) {
        sendAssistantStatusResponse(res);
        return;
      }

      if (req.method !== 'POST') {
        return next();
      }

      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr || '{}');

      if (req.url?.startsWith('/api/chat')) {
        await handleChatEndpoint(body, res);
        return;
      }

      if (req.url?.startsWith('/api/assistant')) {
        await handleAssistantEndpoint(req, res, body);
        return;
      }

      return next();
    } catch (error) {
      viteLogger.error(`[dev-chat-api] ${mode} handler error`, { error });
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `${mode} chat route failed` }));
    }
  };
}
