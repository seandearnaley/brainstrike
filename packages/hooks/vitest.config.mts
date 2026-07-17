import { resolve } from 'node:path';
import { testBase } from '@brainstrike/test-utils/vitest.base';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (context-actions, types, utils subpaths) from
    // SOURCE, not dist. See @brainstrike/test-utils/workspace-src-aliases (#1066).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    ...testBase,
    exclude: ['node_modules', 'dist'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  } as InlineConfig,
});
