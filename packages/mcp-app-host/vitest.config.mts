import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {},
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    name: 'mcp-app-host',
    reporters: ['default', new LostTestFileReporter()],
  },
});
