import { dirname } from 'node:path';
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
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    restoreMocks: true,
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
