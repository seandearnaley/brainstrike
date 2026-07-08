import { testBase } from '@brainstrike/test-utils/vitest.base';
import type { InlineConfig } from 'vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    ...testBase,
    exclude: ['node_modules', 'dist'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  } as InlineConfig,
});
