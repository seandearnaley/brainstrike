/// <reference types="vitest" />
import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (utils, contracts) from SOURCE, not built dist, so a
    // test never depends on another package having been built first.
    alias: workspaceSrcAliases(resolve(import.meta.dirname, '..')),
  },
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
