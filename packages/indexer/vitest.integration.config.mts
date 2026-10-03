import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
