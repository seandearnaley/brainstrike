import path from 'node:path';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

// Only the local Mac unit lane uses parallel forks. Native integration and
// coverage keep the base config; Windows, Linux and explicit shards stay serial.
// Fork isolation remains enabled, so module globals do not cross test files.
const parallelUnits =
  process.platform === 'darwin' &&
  process.env['CI'] !== 'true' &&
  !process.env['DESKTOP_TEST_SHARD'];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    fileParallelism: parallelUnits,
    // BST-546: fail the run when a test leaves new files in this package.
    globalSetup: [
      path.join(import.meta.dirname, 'src/__tests__/helpers/unit-lane-package-write-guard.ts'),
    ],
    maxWorkers: parallelUnits ? 2 : 1,
  },
});
