import { getExpectPollTimeout } from '@brainstrike/test-utils/test-timeouts';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Polls of real hosts and child processes outlast Vitest's 1 s default
      // (BST-2181). The integration config spreads this test block; a call's own
      // options still win.
      expect: { poll: { timeout: getExpectPollTimeout() } },
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
