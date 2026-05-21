import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['dist', 'node_modules'],
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@brainstrike/indexing-contract': resolve(
        __dirname,
        '../../packages/indexing-contract/src/index.ts'
      ),
      '@brainstrike/utils/token-counting-runtime': resolve(
        __dirname,
        '../../packages/utils/src/token-counting-runtime.ts'
      ),
      '@brainstrike/utils/logger': resolve(__dirname, '../../packages/utils/src/logger.ts'),
      '@brainstrike/utils/safe-storage': resolve(
        __dirname,
        '../../packages/utils/src/safe-storage.ts'
      ),
      '@brainstrike/utils': resolve(__dirname, '../../packages/utils/src'),
    },
  },
});
