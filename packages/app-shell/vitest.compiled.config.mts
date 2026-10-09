// React Compiler lane for @brainstrike/app-shell.
//
// The shipped renderer runs the React Compiler (apps/desktop/vite.config.mts),
// which memoizes on what a body reads and drops unread manual dependencies.
// Suites named `*.compiled.test.{ts,tsx}` run here with the source compiled the
// same way, so they can see that. The base lane excludes them.
//
// It reuses the base config and REPLACES only `test.include` and
// `test.exclude`, as vitest.integration.config.mts does.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  plugins: [...(baseConfig.plugins ?? []), react({ compiler: { compilationMode: 'infer' } })],
  test: {
    ...baseConfig.test,
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['src/**/*.compiled.test.{ts,tsx}'],
  },
});
