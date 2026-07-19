import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
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
import { createAgentBrowserSafeAliasEntries } from '../../packages/agent/config/browser-safe-subpath-aliases.mjs';
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
  isContextActionSystemModule,
} = await import('@brainstrike/build-utils');
const reactCompilerBabelPreset = reactCompilerPreset(ReactCompilerConfig);
const wasmPath = findPGliteWasm(__dirname);
const workerpoolBrowserStubAliases = getWorkerpoolBrowserStubAliases(__dirname);

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
                // Co-locate the context-action/command system (prevents the
                // circular chunk-init TDZ that blanks #root in the built
                // renderer — see isContextActionSystemModule in build-utils).
                // Everything else uses rolldown's default reachability-based
                // splitting so dynamically-imported vendors (mermaid, shiki,
                // katex, codemirror, …) stay OFF the startup critical path.
                return isContextActionSystemModule(moduleId) ? 'context-action-system' : null;
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
      // Split pgvector/pg_textsearch packages ship their WASM/tar via import.meta.url;
      // prebundling into .vite/deps breaks that relative asset URL, so exclude like core PGlite.
      '@electric-sql/pglite-pgvector',
      '@electric-sql/pglite-pg_textsearch',
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
    // Array form: first match wins, so deliberate overrides/exceptions come
    // BEFORE the shared registry spread (mirrors apps/desktop/vite.config.mts
    // and the vitest configs' B3/B4 convention, #1651/#1658). Every root/
    // subpath alias the registry emits is an EXACT specifier match (derived
    // from each package's own `exports` map), so — unlike the old object-form
    // map's blanket string-prefix roots — subpath vs. root ordering can no
    // longer shadow anything; only the exceptions below need to precede it.
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
      // NOTE: @brainstrike/file-explorer must alias to DIST (not src) so the worker-storage.worker.js
      // file is properly bundled. Aliasing to src causes the .ts worker file to be emitted without
      // transformation, which browsers cannot execute.
      // The web:dev script has a predev step that ensures file-explorer is built first.
      {
        find: '@brainstrike/file-explorer',
        replacement: path.resolve(__dirname, '../../packages/file-explorer/dist'),
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
      // NOTE: Do NOT alias @brainstrike/agent to source - server-side routes need the
      // full package which has Node.js dependencies. Only the /client subpath is browser-safe.
      // The registry EXCLUDES @brainstrike/agent's root by default (DEFAULT_SRC_ALIAS_EXCLUSIONS),
      // so no override is needed here to preserve that — only the browser-safe subpaths below.
      // Agent browser-safe subpath exports (no Mastra dependencies)
      ...createAgentBrowserSafeAliasEntries(path.resolve(__dirname, '../../packages/agent')),
      { find: 'src', replacement: path.resolve(__dirname, './src') },
      ...Object.entries(workerpoolBrowserStubAliases).map(([find, replacement]) => ({
        find,
        replacement,
      })),
      // Force pino to browser build to avoid dynamic require of node libs
      { find: 'pino', replacement: pinoBrowserPath },
      { find: 'pino/browser.js', replacement: pinoBrowserPath },
      { find: './fs/nodefs.js', replacement: './fs/opfs-ahp.js' },
      // Force PGlite to use browser FS implementation in web renderer to avoid node:fs imports
      {
        find: '@electric-sql/pglite/dist/fs/nodefs.js',
        replacement: '@electric-sql/pglite/dist/fs/opfs-ahp.js',
      },
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
  const { createAssistantApiMiddleware } = await import('./src/server/assistant-api-middleware.ts');
  return createAssistantApiMiddleware(mode);
}
