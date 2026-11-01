/// <reference types="vitest" />

import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

/** Vitest 4 configuration for @brainstrike/storage: one jsdom project. */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      projects: [
        {
          test: {
            environment: 'jsdom',
            exclude: ['node_modules', 'dist'],
            globals: true,
            include: ['src/__tests__/**/*.test.{ts,tsx}'],
            name: 'unit',
          },
        },
      ],
    },
  })
);
