import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    include: ['test/**/*.test.ts'],
  },
});
