import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export function resolveAgentTestShard(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const shard = environment['AGENT_TEST_SHARD'];
  if (!shard) {
    if (environment['AGENT_TEST_SHARD_REQUIRED'] === 'true') {
      throw new Error('AGENT_TEST_SHARD is required for the Agent native-shard task');
    }
    return;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(shard);
  if (!match?.groups) {
    throw new Error(`AGENT_TEST_SHARD must use Vitest's i/N form; received "${shard}"`);
  }
  if (Number(match.groups.index) > Number(match.groups.count)) {
    throw new Error(`AGENT_TEST_SHARD index must not exceed its count; received "${shard}"`);
  }
  return shard;
}

const agentTestShard = resolveAgentTestShard();

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      ...(agentTestShard ? { shard: agentTestShard } : {}),
      hookTimeout: 15_000,
      include: ['src/**/__tests__/*.spec.ts'],
      setupFiles: ['./vitest.setup.ts'],
      // Longer timeout for MCP/Mastra integration tests under parallel load
      testTimeout: 30_000,
    },
  })
);
