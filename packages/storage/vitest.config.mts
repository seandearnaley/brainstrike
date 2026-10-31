/// <reference types="vitest" />

import path from 'node:path';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

/** Vitest 4 configuration for @brainstrike/storage: one jsdom project with Electron mocked. */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      projects: [
        {
          resolve: {
            alias: [
              {
                find: 'electron',
                replacement: path.resolve(import.meta.dirname, '__mocks__/electron.ts'),
              },
            ],
          },
          test: {
            environment: 'jsdom',
            exclude: ['node_modules', 'dist'],
            globals: true,
            include: ['src/__tests__/**/*.test.{ts,tsx}'],
            name: 'unit',
            // Vitest 4: server.deps replaces the deprecated deps config
            server: {
              deps: {
                external: ['electron'],
              },
            },
          },
        },
      ],
    },
  })
);
