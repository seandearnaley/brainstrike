import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist', '**/*.integration.test.ts'],
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
