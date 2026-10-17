import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // agent-host's boundary wire reaches the agent's Node-side subpaths; the tests run their source.
      {
        find: /^@brainstrike\/agent$/,
        replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
      },
      ...['mcp-client', 'hosted-web', 'provider-request', 'provider-runtime', 'tool-runtime'].map(
        (subpath) => ({
          find: new RegExp(`^@brainstrike/agent/${subpath}$`),
          replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
        })
      ),
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    name: 'host-conversation',
    reporters: ['default', new LostTestFileReporter()],
  },
});
