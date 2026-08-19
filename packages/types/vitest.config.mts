import { defineConfig } from 'vitest/config';
// Relative, NOT the `@brainstrike/test-utils` specifier: test-utils depends on
// @brainstrike/types, so declaring test-utils as a devDependency here makes
// turbo's task graph cyclic ("Cyclic dependency detected: @brainstrike/
// test-utils#build, @brainstrike/types#build"). The reporter is a plain .mjs
// with no build step, so a path import needs no dependency edge.
import LostTestFileReporter from '../test-utils/vitest-lost-file-reporter.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    // setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
