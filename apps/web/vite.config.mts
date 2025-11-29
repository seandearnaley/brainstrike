import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@brainstrike/utils';
import { codecovVitePlugin } from '@codecov/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { defineConfig } from 'vitest/config';
import { getDevCSP } from './src/csp-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viteLogger = createLogger('WebViteConfig');

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' };

// Keep config concise; avoid noisy debug printing in dev

// The Tailwind CSS content paths are now managed by `tailwind.config.js`.
// The @tailwindcss/vite plugin will automatically pick it up.

const { findPGliteWasm, fullReloadOnCompilerHotspots } = await import('@brainstrike/build-utils');
const wasmPath = findPGliteWasm(__dirname);

export default defineConfig({
  cacheDir: path.resolve(__dirname, '.vite'),
  server: {
    port: 8080,
    host: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': getDevCSP(),
    },
    proxy: {
      // Proxy Hugging Face requests to avoid CORS issues
      '/api/hf': {
        target: 'https://huggingface.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hf/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Add headers to ensure we get JSON responses
            proxyReq.setHeader('Accept', 'application/json');
            proxyReq.setHeader('User-Agent', 'transformers.js');
          });
        },
      },
    },
  },
  define: {
    'process.env': {},
    'process.env.EMBED_QUEUE_ENABLED': JSON.stringify(
      process.env['EMBED_QUEUE_ENABLED'] ?? 'false'
    ),
    'process.env.LOCAL_FIRST_DB': JSON.stringify(
      process.env['LOCAL_FIRST_DB'] ?? process.env['EMBED_QUEUE_ENABLED'] ?? 'false'
    ),
    'process.browser': true,
    'process.version': '"v22.0.0"',
    'process.platform': '"browser"',
  },
  plugins: [
    fullReloadOnCompilerHotspots(),
    wasm(),
    topLevelAwait(),
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
      },
      // Ensure consistent development transforms for React Compiler
      jsxRuntime: 'automatic',
    }),
    tailwindcss(), // Automatically finds and uses the root tailwind.config.js
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
    // Conditionally configure Codecov plugin
    ...(process.env['CODECOV_TOKEN']
      ? [
          codecovVitePlugin({
            enableBundleAnalysis: true,
            bundleName: 'brainstrike-web-bundle',
            uploadToken: process.env['CODECOV_TOKEN'],
          }),
        ]
      : []), // If no token, don't include the plugin config
    // Dev/preview middleware for /api/chat to support E2E and local dev
    devChatApiPlugin(),
  ],
  assetsInclude: ['**/*.png'],
  build: {
    minify: 'terser', // Use terser for better minification
    terserOptions: {
      // biome-ignore lint/style/useNamingConvention: required for terser drop_console target
      compress: { drop_console: false },
    },
    outDir: 'dist', // Output directory for the build - cache bust
    assetsDir: 'assets', // Directory for static assets within the build output
    sourcemap: false, // Disable sourcemaps for production build
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ['electron', 'chokidar', '@mastra/core', /^@mastra\//],
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
      src: path.resolve(__dirname, './src'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
      // Map stylesheet imports to source files for consistent theme loading
      '@brainstrike/app-shell/styles.css': path.resolve(
        __dirname,
        '../../packages/app-shell/styles.css'
      ),
      '@brainstrike/file-explorer-ui/styles.css': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/styles.css'
      ),
      '@brainstrike/ui/styles.css': path.resolve(__dirname, '../../packages/ui/styles.css'),
      '@brainstrike/ui/globals.css': path.resolve(__dirname, '../../packages/ui/src/globals.css'),
      // Source alias to ensure consistent React Compiler transforms and HMR
      '@brainstrike/file-explorer-ui': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/src'
      ),
      // Ensure hooks resolve to source once to avoid duplicates
      '@brainstrike/file-explorer-hooks': path.resolve(
        __dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../../packages/file-system/src'),
      '@brainstrike/types': path.resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/workers': path.resolve(__dirname, '../../packages/workers'),
      // Agent client-safe exports (no Mastra dependencies)
      '@brainstrike/agent/client': path.resolve(__dirname, '../../packages/agent/src/client.ts'),
      // Force PGlite to use browser FS implementation in web renderer to avoid node:fs imports
      '@electric-sql/pglite/dist/fs/nodefs.js': '@electric-sql/pglite/dist/fs/opfs-ahp.js',
      './fs/nodefs.js': './fs/opfs-ahp.js',
      // remove duplicate hooks alias
    },
  },
  worker: {
    format: 'es',
    plugins: () => [],
  },
  optimizeDeps: {
    exclude: [
      '@electric-sql/pglite', // Official PGlite requirement
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
    include: [
      'react-helmet-async', // Explicitly include to prevent cache issues
    ],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        '**/*.{config,config.*}',
      ],
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    reporters: ['default', 'hanging-process'],
    silent: true,
    onConsoleLog: (log: string, type: 'stdout' | 'stderr') => {
      if (type === 'stderr' && log.includes('ERROR') && !log.includes('Error: Not implemented')) {
        return true;
      }
      return false;
    },
    // Coverage consolidated at root vitest.config.ts
    mockReset: true,
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
  },
});

// Minimal dev/preview plugin to serve /api/chat using our agent
function devChatApiPlugin() {
  return {
    name: 'dev-chat-api',
    async configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(await createApiMiddleware('dev'));
    },
    async configurePreviewServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(await createApiMiddleware('preview'));
    },
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

      if (req.method !== 'POST') return next();

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
