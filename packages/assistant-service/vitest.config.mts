import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
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
      {
        find: '@brainstrike/agent/hosted-web',
        replacement: resolve(agentDir, 'src/hosted-web.ts'),
      },
      ...createAgentBrowserSafeAliasEntries(agentDir),
      // Resolve remaining workspace deps from SOURCE, not dist.
      // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
