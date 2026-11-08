import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The report every other package gets from @brainstrike/test-utils/vitest.base.
    coverage: {
      reporter: [
        'text-summary',
        ['lcovonly', { projectRoot: fileURLToPath(new URL('../..', import.meta.url)) }],
      ],
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['__tests__/**/*.test.{ts,tsx}'],
  },
});
