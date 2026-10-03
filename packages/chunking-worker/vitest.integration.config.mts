import { defineConfig } from 'vitest/config';
import config from './vitest.config.mjs';

export default defineConfig({
  ...config,
  test: { ...config.test, include: ['src/__tests__/**/*.integration.test.ts'] },
});
