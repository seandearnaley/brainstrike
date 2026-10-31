import { testBase } from '@brainstrike/test-utils/vitest.base';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [reactCompiler()],
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    ...testBase,
    exclude: ['node_modules', 'dist'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  } as InlineConfig,
});
