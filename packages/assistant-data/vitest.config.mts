import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const workspaceAliases = workspaceSrcAliases(resolve(import.meta.dirname, '..'));

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    coverage: {
      exclude: ['**/__tests__/**', '**/*.d.ts', '**/dist/**', '**/index.ts'],
      include: ['src/**/*.{ts,tsx}'],
    },
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
