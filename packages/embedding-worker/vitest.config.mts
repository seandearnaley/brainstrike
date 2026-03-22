import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser';

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
  isCI,
  headless: isCI,
  testPattern: 'test/**/*.browser.test.{ts,tsx}',
  launchArgs: isCI ? [...WEBGPU_CI_LAUNCH_ARGS] : undefined,
});

browserProject.test.globals = true;
if (!runWebGpuMemory) {
  browserProject.test.exclude = ['test/webgpu-memory-growth.browser.test.ts'];
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
          include: ['test/**/*.spec.ts'],
          exclude: ['dist', 'node_modules', '**/*.browser.test.*'],
          restoreMocks: true,
          clearMocks: true,
          coverage: {
            enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.*', '**/__tests__/**', '**/dist/**', '**/node_modules/**'],
          },
        },
      },
      browserProject,
    ],
  },
});
