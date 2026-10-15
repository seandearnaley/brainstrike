import { resolve } from 'node:path';
import {
  getHeavyRuntimeOptimizeDepsExclude,
  transformersOnnxRuntimeWasmUrlsPlugin,
} from '@brainstrike/build-utils';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

// Resolve workspace deps (worker-runtime, indexing-contract, types) from SOURCE,
// not built dist. Applied per-project (vitest 4 does not inherit the root-level
// resolve into `test.projects`). See workspace-src-aliases (incident #1066).
const srcAliases = workspaceSrcAliases(resolve(import.meta.dirname, '..'));
// The ONNX Runtime WASM URLs `src/vite.ts` imports, from Transformers.js's own
// onnxruntime-web (BST-2003), as the apps serve them.
const onnxRuntimeWasmUrls = transformersOnnxRuntimeWasmUrlsPlugin([import.meta.dirname]);

const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
const runWebGpuMemory = process.env['VITEST_RUN_WEBGPU_MEMORY'] === 'true';
const WEBGPU_CI_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-setuid-sandbox',
  '--disable-features=VizDisplayCompositor',
  '--headless=new',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--disable-vulkan-surface',
  '--enable-unsafe-webgpu',
] as const;

const browserProject = createBrowserProject({
  // See BST-1299: the browser page has no `process`, so the multiplier-scaled
  // @testing-library/dom budget must be resolved here and handed over.
  asyncUtilTimeout: getAsyncUtilTimeout(),
  headless: isCI,
  isCI,
  launchArgs: isCI ? [...WEBGPU_CI_LAUNCH_ARGS] : undefined,
  // Owned by the caller, not defaulted inside @brainstrike/config: that
  // package is `tooling` and cannot depend on @brainstrike/test-utils, and a
  // factory default would be silently droppable by the `...browserProject.test`
  // spread below.
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: 'test/**/*.browser.test.{ts,tsx}',
});

browserProject.test.globals = true;
browserProject.resolve = { ...browserProject.resolve, alias: srcAliases };
browserProject.plugins = [...(browserProject.plugins ?? []), onnxRuntimeWasmUrls];
// As the apps serve it: Transformers.js unbundled. Discovered mid-run instead, it
// re-optimizes and reloads the page under a running test.
browserProject.optimizeDeps = { exclude: [...getHeavyRuntimeOptimizeDepsExclude()] };
if (!runWebGpuMemory) {
  browserProject.test.exclude = ['test/webgpu-memory-growth.browser.test.ts'];
}

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [onnxRuntimeWasmUrls],
        resolve: { alias: srcAliases },
        test: {
          clearMocks: true,
          coverage: {
            enabled:
              process.env['COVERAGE'] !== 'false' &&
              (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true'),
            exclude: ['**/*.test.*', '**/__tests__/**', '**/dist/**', '**/node_modules/**'],
            include: ['src/**/*.ts'],
            provider: 'v8',
          },
          environment: 'node',
          exclude: ['dist', 'node_modules', '**/*.browser.test.*'],
          globals: true,
          include: ['test/**/*.spec.ts'],
          name: 'unit',
          restoreMocks: true,
          setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
        },
      },
      browserProject,
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
