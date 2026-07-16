import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

// Resolve workspace deps (worker-runtime, indexing-contract, types) from SOURCE,
// not built dist. Applied per-project (vitest 4 does not inherit the root-level
// resolve into `test.projects`). See workspace-src-aliases (incident #1066).
const srcAliases = workspaceSrcAliases(resolve(import.meta.dirname, '..'));

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
  headless: isCI,
  isCI,
  launchArgs: isCI ? [...WEBGPU_CI_LAUNCH_ARGS] : undefined,
  testPattern: 'test/**/*.browser.test.{ts,tsx}',
});

browserProject.test.globals = true;
browserProject.resolve = { ...browserProject.resolve, alias: srcAliases };
if (!runWebGpuMemory) {
  browserProject.test.exclude = ['test/webgpu-memory-growth.browser.test.ts'];
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: srcAliases },
        test: {
          clearMocks: true,
          coverage: {
            enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
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
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
        },
      },
      browserProject,
    ],
  },
});
