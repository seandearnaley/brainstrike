import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';
import { createAgentBrowserSafeAliasEntries } from '../agent/config/browser-safe-subpath-aliases.mjs';

const agentDir = resolve(import.meta.dirname, '../agent');

export default defineConfig({
  resolve: {
    alias: [
      // @brainstrike/agent is deliberately excluded from the blanket spread
      // (its root pulls Mastra/Node-only deps that break BROWSER tests). This
      // package's tests run in node, so aliasing the root + node-only
      // subpaths to source is safe; first-match wins over the spread below.
      { find: /^@brainstrike\/agent$/, replacement: resolve(agentDir, 'src/index.ts') },
      ...createAgentBrowserSafeAliasEntries(agentDir),
    ],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    fsModuleCache: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
