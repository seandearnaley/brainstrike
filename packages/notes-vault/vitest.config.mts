/// <reference types="vitest" />
import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps from SOURCE, not built dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    server: {
      deps: {
        // react-shiki@0.10+ ships a top-level `import './style.css'` side effect;
        // Vitest externalizes node_modules by default, which hands that CSS import
        // to Node's native ESM loader. Inlining forces Vite to handle it (mirrors
        // packages/ui/vitest.config.mts).
        inline: ['react-shiki'],
      },
    },
    setupFiles: ['../test-utils/src/vitest.setup.ts'],
  },
});
