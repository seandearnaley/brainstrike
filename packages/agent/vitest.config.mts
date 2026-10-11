import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

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

export default defineConfig({
  coverage: {
    enabled: coverageEnabled,
    include: ['src/**/*.{ts,tsx}'],
    provider: 'v8',
    reporter: ['text', 'json', 'lcov'],
  },
  resolve: {
    // Resolve workspace deps (assistant-contract, text-splitter, types, utils)
    // from SOURCE, not built dist. @brainstrike/agent itself is intentionally
    // excluded by the registry (Mastra/Node deps); this lane does not import it.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [
      {
        find: '@brainstrike/agent/mcp-client',
        replacement: resolve(import.meta.dirname, 'src/mcp-client.ts'),
      },
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    ...(agentTestShard ? { shard: agentTestShard } : {}),
    environment: 'node',
    hookTimeout: 15_000,
    include: ['src/**/__tests__/*.spec.ts'],
    // The root test plan runs four packages concurrently; do not give each
    // package the entire machine's worker pool as well.
    ...(process.env['TURBO_TEST_MODE'] ? { maxWorkers: 2 } : {}),
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.event-loop-watchdog.setup', './vitest.setup.ts'],
    // Longer timeout for MCP/Mastra integration tests under parallel load
    testTimeout: 30_000,
  },
});
