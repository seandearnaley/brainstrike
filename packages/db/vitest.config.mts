/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps (utils, contracts) from SOURCE, not built dist, so a
    // test never depends on another package having been built first.
  },
});
