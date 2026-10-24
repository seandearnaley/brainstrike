import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    globals: true,
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    restoreMocks: true,
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
