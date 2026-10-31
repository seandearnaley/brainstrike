import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

/** One project, `unit`, which runs in Node. */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      projects: [
        {
          test: {
            // The integration lane runs the native-process fixtures (vitest.integration.config.mts).
            exclude: ['**/*.integration.test.ts', 'node_modules', 'dist'],
            globals: true,
            include: ['__tests__/**/*.test.ts'],
            name: 'unit',
            setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
          },
        },
      ],
    },
  })
);
