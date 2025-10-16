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
    include: ['test/**/*.spec.ts'],
    exclude: ['dist', 'node_modules'],
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@brainstrike/embedding-worker': resolve(
        __dirname,
        '../../packages/embedding-worker/src/index.ts'
      ),
      '@brainstrike/utils': resolve(__dirname, '../../packages/utils/src/index.ts'),
    },
  },
});
