import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    // BST-2246: like the app's process entries, every test process makes the current
    // user the default owner first, so an elevated Windows run creates private
    // directories it owns.
    setupFiles: ['@brainstrike/secure-fs-native/default-owner'],
    testTimeout: 60_000,
  },
});
