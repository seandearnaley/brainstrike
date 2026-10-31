/// <reference types="vitest" />
/// <reference types="@testing-library/jest-dom" />

import path from 'node:path';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

// CI splits this lane into native Vitest shards (the Unit app-shell rows in
// .github/workflows/test.yml).
export function resolveAppShellTestShard(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const shard = environment['APP_SHELL_TEST_SHARD'];
  if (!shard) {
    if (environment['APP_SHELL_TEST_SHARD_REQUIRED'] === 'true') {
      throw new Error('APP_SHELL_TEST_SHARD is required for the App Shell native-shard task');
    }
    return;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(shard);
  if (!match?.groups) {
    throw new Error(`APP_SHELL_TEST_SHARD must use Vitest's i/N form; received "${shard}"`);
  }
  if (Number(match.groups.index) > Number(match.groups.count)) {
    throw new Error(`APP_SHELL_TEST_SHARD index must not exceed its count; received "${shard}"`);
  }
  return shard;
}

const appShellTestShard = resolveAppShellTestShard();

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    resolve: {
      alias: [
        {
          find: 'electron',
          replacement: path.resolve(import.meta.dirname, '../storage/__mocks__/electron.ts'),
        },
      ],
    },
    server: {
      fs: {
        allow: ['.'],
      },
    },
    test: {
      environment: 'happy-dom',
      exclude: ['**/node_modules/**', '**/dist/**'],
      ...(appShellTestShard ? { shard: appShellTestShard } : {}),
      hookTimeout: 30_000,
      include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      setupFiles: ['./vitest.setup.ts'],
      testTimeout: 30_000,
      unstubGlobals: true,
      // Coverage consolidated at root vitest.config.mts
    },
  })
);
