import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/indexing-contract': resolve(
        __dirname,
        '../../packages/indexing-contract/src/index.ts'
      ),
      '@brainstrike/utils': resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/utils/logger': resolve(__dirname, '../../packages/utils/src/logger.ts'),
      '@brainstrike/utils/token-counting-runtime': resolve(
        __dirname,
        '../../packages/utils/src/token-counting-runtime.ts'
      ),
    },
  },
  test: {
    clearMocks: true,
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    globals: true,
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    restoreMocks: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
