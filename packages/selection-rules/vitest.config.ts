import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@brainstrike/utils/string-prefix': path.resolve(
        import.meta.dirname,
        '../utils/src/string-prefix'
      ),
      '@brainstrike/utils': path.resolve(import.meta.dirname, '../utils/src'),
      // Transitive: @brainstrike/utils source imports from @brainstrike/types.
      // This alias is needed because resolving @brainstrike/utils from source
      // (above) bypasses the normal package resolution, so its transitive
      // dependency on @brainstrike/types must also be aliased explicitly.
      '@brainstrike/types': path.resolve(import.meta.dirname, '../types/src'),
    },
  },
});
