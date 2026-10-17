import { resolve } from 'node:path';
import { getHeavyRuntimeOptimizeDepsExclude } from '@brainstrike/build-utils';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const aliases = [
  // The corpus setup stores runs with Core's encoder, whose imports reach Node-only provider code.
  {
    find: /^@brainstrike\/agent$/,
    replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
  },
  ...['mcp-client', 'hosted-web', 'provider-request', 'provider-runtime', 'tool-runtime'].map(
    (subpath) => ({
      find: new RegExp(`^@brainstrike/agent/${subpath}$`),
      replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
    })
  ),
  // The shared registry skips prebuilt worker exports; the tests run the worker's source.
  {
    find: '@brainstrike/embedding-worker/worker',
    replacement: resolve(import.meta.dirname, '../embedding-worker/src/embedding.worker.ts'),
  },
  ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
];

// A worker realm has no Vitest runner for the dynamic imports Vitest rewrites;
// every worker entry module (`*-worker.ts`, `*.worker.ts`) imports the realm's
// stand-in first. In the page, where the runner exists, the stand-in does nothing.
const workerRealm = resolve(import.meta.dirname, 'src/__tests__/fixtures/vitest-worker-realm.ts');
const workerRealmPlugin = {
  enforce: 'pre' as const,
  name: 'brainstrike:vitest-worker-realm',
  transform(code: string, id: string) {
    return /[.-]worker\.ts$/u.test(id) ? `import ${JSON.stringify(workerRealm)};\n${code}` : null;
  },
};

const browserProject = createBrowserProject({
  asyncUtilTimeout: getAsyncUtilTimeout(),
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: 'src/**/*.browser.test.ts',
});

/**
 * Two projects. `unit` runs in Node: the composed worker's browser bundle.
 * `browser` runs in Chromium: the composed writer worker on OPFS, with the
 * derived index beside the state DB.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          environment: 'node',
          exclude: ['**/*.browser.test.ts', 'node_modules', 'dist'],
          include: ['src/**/__tests__/**/*.test.ts'],
          name: 'unit',
          testTimeout: 30_000,
        },
      },
      {
        optimizeDeps: {
          // The engine resolves its wasm next to its own module; pre-bundling would move it.
          // Transformers.js is the embedding worker's runtime; the tests' synthetic one replaces it.
          exclude: ['@sqlite.org/sqlite-wasm', ...getHeavyRuntimeOptimizeDepsExclude()],
          // Found only once a worker loads them, they would be optimized mid-run, and
          // Vite's reload would end the other files' workers.
          include: [
            '@brainstrike/chunking-worker > @babel/parser',
            '@brainstrike/chunking-worker > web-tree-sitter',
            '@brainstrike/file-system > idb',
            '@brainstrike/queue > workerpool',
            '@brainstrike/utils > ignore',
            '@brainstrike/utils > minimatch',
          ],
        },
        plugins: [workerRealmPlugin],
        resolve: { alias: aliases },
        test: {
          ...browserProject.test,
          globalSetup: [
            './src/__tests__/stored-host-corpus.global.ts',
            './src/__tests__/recorded-proxy-turn.global.ts',
          ],
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
