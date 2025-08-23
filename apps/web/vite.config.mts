import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPGliteWasm, fullReloadOnCompilerHotspots } from '@brainstrike/build-utils';
import { getDevCSP } from '@brainstrike/security';
import { codecovVitePlugin } from '@codecov/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

function debugPlugin() {
  return {
    name: 'debug-build-context',
    buildStart() {
      if (isDev) {
        console.log('=== DEBUG PLUGIN BUILDSTART ===');
        console.log('Build starting, CWD:', process.cwd());
        console.log('Vercel env:', process.env['VERCEL']);
        console.log('=== END DEBUG PLUGIN ===');
      }
    },
  };
}

function copyFontsPlugin() {
  return {
    name: 'copy-fonts',
    buildStart() {
      // Copy fonts from the fonts package to public and dist directories
      const fontsPackagePath = path.resolve(__dirname, '../../packages/fonts/src/inter');
      const publicFontsPath = path.resolve(__dirname, 'public/fonts/inter');
      const distFontsPath = path.resolve(__dirname, 'dist/fonts/inter');

      // Create the public fonts directory if it doesn't exist
      if (!existsSync(path.resolve(__dirname, 'public/fonts'))) {
        mkdirSync(path.resolve(__dirname, 'public/fonts'), { recursive: true });
      }
      if (!existsSync(publicFontsPath)) {
        mkdirSync(publicFontsPath, { recursive: true });
      }
      if (!existsSync(distFontsPath)) {
        mkdirSync(distFontsPath, { recursive: true });
      }

      // Copy font files
      const fontFiles = ['InterVariable.ttf', 'InterVariable-Italic.ttf'];
      fontFiles.forEach((file) => {
        const src = path.join(fontsPackagePath, file);
        const destPublic = path.join(publicFontsPath, file);
        const destDist = path.join(distFontsPath, file);
        if (existsSync(src)) {
          copyFileSync(src, destPublic);
          copyFileSync(src, destDist);
          if (isDev) {
            console.log(`Copied font: ${file}`);
          }
        }
      });
    },
  };
}

const wasmPath = findPGliteWasm(__dirname);

// React Compiler: enabled in dev and prod; HMR guardrails in dev to avoid mis-compiles
const ReactCompilerConfig = { compilationMode: 'infer' };

// CRITICAL DEBUG: Force console output to appear in logs - CACHE BUST v3
if (isDev) {
  console.log('=== VITE CONFIG DEBUG START (FORCE DEPLOY v3) ===');
  console.log('Current working directory:', process.cwd());
  console.log('__dirname:', __dirname);
  console.log('process.env.VERCEL:', process.env['VERCEL']);
  console.log('process.env.CI:', process.env['CI']);
  console.log('=== VITE CONFIG DEBUG END ===');
}

// The Tailwind CSS content paths are now managed by `tailwind.config.js`.
// The @tailwindcss/vite plugin will automatically pick it up.

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
    'process.browser': true,
    'process.version': '"v22.0.0"',
    'process.platform': '"browser"',
  },
  plugins: [
    fullReloadOnCompilerHotspots(),
    debugPlugin(),
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
    copyFontsPlugin(),
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
  ],
  assetsInclude: ['**/*.png'],
  build: {
    minify: 'terser', // Use terser for better minification
    terserOptions: {
      compress: { drop_console: false },
    },
    outDir: 'dist', // Output directory for the build - cache bust
    assetsDir: 'assets', // Directory for static assets within the build output
    sourcemap: false, // Disable sourcemaps for production build
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ['electron', 'chokidar'],
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
      '@brainstrike/security': path.resolve(__dirname, '../../packages/security/src'),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
      // Map stylesheet import to package root css before package alias
      '@brainstrike/file-explorer-ui/styles.css': path.resolve(
        __dirname,
        '../../packages/file-explorer-ui/styles.css'
      ),
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
      '@brainstrike/config': path.resolve(__dirname, '../../packages/config/src'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../../packages/file-system/src'),
      '@brainstrike/types': path.resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/workers': path.resolve(__dirname, '../../packages/workers'),
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
      '@brainstrike/security',
      '@brainstrike/config',
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
    reporters: ['default', 'hanging-process'],
    silent: true,
    onConsoleLog: (log: string, type: 'stdout' | 'stderr') => {
      if (type === 'stderr' && log.includes('ERROR') && !log.includes('Error: Not implemented')) {
        return true;
      }
      return false;
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'coverage/**',
        'dist/**',
        '**/[.]**',
        'packages/*/test{,s}/**',
        '**/*.d.ts',
        'cypress/**',
        'test{,s}/**',
        'test{,-*}.{js,cjs,mjs,ts,tsx,jsx}',
        '**/*{.,-}test.{js,cjs,mjs,ts,tsx,jsx}',
        '**/*{.,-}spec.{js,cjs,mjs,ts,tsx,jsx}',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress}.config.*',
        '**/.{eslint,mocha,prettier}rc.{js,cjs,yml}',
      ],
      all: true,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
    mockReset: true,
    deps: {
      inline: ['@brainstrike/types', '@brainstrike/hooks', '@brainstrike/ui', '@brainstrike/utils'],
    },
  },
});
