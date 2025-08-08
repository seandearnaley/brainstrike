import { defineConfig } from 'vitest/config';

// Root Vitest config for the monorepo.
// Uses the modern `test.projects` API to aggregate package/app projects.
// This replaces separate vitest.workspace.* files and avoids editor warnings.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
