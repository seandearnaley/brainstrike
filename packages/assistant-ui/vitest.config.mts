import { createBrowserProject } from '@brainstrike/config/vitest-browser';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import type { BrowserCommand, BrowserConfigOptions } from 'vitest/node';

const emulateReducedMotion: BrowserCommand<[options: { enabled: boolean | null }]> = async (
  { page },
  { enabled }
): Promise<void> => {
  await page.emulateMedia({
    reducedMotion: enabled === null ? null : enabled ? 'reduce' : 'no-preference',
  });
};

const browserProject = createBrowserProject({
  // Carries TEST_TIMEOUT_MULTIPLIER into the browser page, where `process`
  // does not exist and @testing-library/dom would otherwise sit on its
  // unscalable 1s waitFor default (BST-1299).
  asyncUtilTimeout: getAsyncUtilTimeout(),
  // Owned by the caller, not defaulted inside @brainstrike/config: that
  // package is `tooling` and cannot depend on @brainstrike/test-utils, and a
  // factory default would be silently droppable by the `...browserProject.test`
  // spread below.
  setupFiles: [
    '@brainstrike/test-utils/vitest.browser.setup',
    './src/__tests__/browser-one-time-chunks.setup.ts',
  ],
  testPattern: 'src/**/*.browser.test.{ts,tsx}',
});

const sharedBrowserOptions: BrowserConfigOptions = browserProject.test.browser;

export default mergeConfig(
  sharedConfig,
  defineConfig({
    optimizeDeps: {
      include: ['@testing-library/jest-dom/vitest'],
    },
    plugins: [tailwindcss()],
    test: {
      projects: [
        {
          plugins: [reactCompiler()],
          test: {
            coverage: {
              exclude: [
                '**/__tests__/**',
                '**/*.browser.test.{ts,tsx}',
                '**/*.d.ts',
                '**/types.ts',
                '**/types/**',
                '**/dist/**',
                '**/index.ts',
              ],
              include: ['src/**/*.{ts,tsx}'],
            },
            environment: 'happy-dom',
            exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
            globals: true,
            include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
            maxWorkers: '100%',
            name: 'unit',
            sequence: {
              groupOrder: 0,
            },
            setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
          },
        },
        {
          optimizeDeps: {
            include: [
              '@assistant-ui/react',
              '@tanstack/react-virtual',
              // The browser setup file imports @testing-library/dom DIRECTLY, a
              // specifier no suite here writes. Listed so it is pre-bundled with
              // (not discovered after, and re-optimized alongside) the copy
              // @testing-library/react resolves — a split there would apply the
              // async-util budget to an instance no `waitFor` reads.
              '@testing-library/dom',
              '@testing-library/jest-dom/vitest',
              '@testing-library/react',
              'react',
              'react-dom',
              'react-dom/client',
            ],
          },
          plugins: [reactCompiler()],
          resolve: {
            dedupe: ['react', 'react-dom'],
          },
          test: {
            ...browserProject.test,
            browser: {
              ...sharedBrowserOptions,
              commands: {
                ...sharedBrowserOptions.commands,
                emulateReducedMotion,
              },
            },
            globals: true,
            sequence: {
              groupOrder: 1,
            },
          },
        },
      ],
    },
  })
);
