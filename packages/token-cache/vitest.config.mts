import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps from SOURCE, not built dist — including TRANSITIVE
    // ones (e.g. @brainstrike/context-actions via hooks src, which the old hand
    // map missed). Prebuilt worker-bundle exports (token-cache/worker) keep
    // resolving to dist via exports — the registry never aliases *.worker.
    // See @brainstrike/test-utils/workspace-src-aliases (#1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    coverage: {
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.tsx', 'src/**/*.spec.tsx'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
  },
});
