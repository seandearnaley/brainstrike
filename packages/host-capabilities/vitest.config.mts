import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from './__tests__/fixtures/real-process-budget.ts';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Both scale with the real-process step budget (BST-2157): hookTimeout covers
      // cleanup's sequential waits, testTimeout a real-bin test's bin calls.
      hookTimeout: HOOK_TIMEOUT_MS,
      include: ['__tests__/**/*.test.ts'],
      // BST-2246: like the app's process entries, every test process makes the current
      // user the default owner first, so an elevated Windows run creates private
      // directories it owns.
      setupFiles: ['@brainstrike/secure-fs-native/default-owner'],
      testTimeout: TEST_TIMEOUT_MS,
    },
  })
);
