import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { reportOnFailure: true },
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    include: ['src/__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 15_000,
  },
});
