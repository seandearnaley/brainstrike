import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      hookTimeout: 120_000,
      include: ['__tests__/**/*.test.ts'],
      // BST-2246: like the app's process entries, every test process makes the current
      // user the default owner first, so an elevated Windows run creates private
      // directories it owns.
      setupFiles: ['@brainstrike/secure-fs-native/default-owner'],
      testTimeout: 60_000,
    },
  })
);
