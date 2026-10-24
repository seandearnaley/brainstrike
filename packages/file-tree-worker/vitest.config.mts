import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json'],
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    reporters: ['default', new LostTestFileReporter()],
  },
});
