import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

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
    environment: 'node',
    hookTimeout: 15_000,
    include: ['src/**/__tests__/*.spec.ts'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['./vitest.setup.ts', '@brainstrike/test-utils/vitest.event-loop-watchdog.setup'],
    // Longer timeout for MCP/Mastra integration tests under parallel load
    testTimeout: 30_000,
  },
});
