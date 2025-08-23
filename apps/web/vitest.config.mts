import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    include: ['@brainstrike/hooks'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'e2e/utils/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/.vite/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/__tests__/**',
        '**/*.config.*',
        '**/vitest.config.*',
        '**/vite.config.*',
        '**/playwright.config.*',
        '**/tailwind.config.*',
        '**/e2e/**',
        '**/src/main.tsx', // Entry point
        '**/src/vite-env.d.ts', // Type definitions
        '../../packages/**', // Exclude monorepo package sources from app coverage
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    // Inline all workspace packages so Vitest transforms them instead of Node resolving built dists
    deps: {
      inline: [/^@brainstrike\//],
    },
  },
  resolve: {
    alias: [
      {
        find: '@brainstrike/app-shell',
        replacement: resolve(__dirname, '../../packages/app-shell/src'),
      },
      { find: '@brainstrike/types', replacement: resolve(__dirname, '../../packages/types/src') },
      { find: '@brainstrike/hooks', replacement: resolve(__dirname, '../../packages/hooks/src') },
      { find: '@brainstrike/ui', replacement: resolve(__dirname, '../../packages/ui/src') },
      // Use source for utils so Vitest transforms internal imports
      { find: '@brainstrike/utils', replacement: resolve(__dirname, '../../packages/utils/src') },
      // Use source for config to avoid prebuilt artifact resolution issues in tests
      { find: '@brainstrike/config', replacement: resolve(__dirname, '../../packages/config/src') },
      // Ensure file-system resolves to source to avoid built output importing @brainstrike/config dist
      {
        find: '@brainstrike/file-system',
        replacement: resolve(__dirname, '../../packages/file-system/src'),
      },
      {
        find: '@brainstrike/file-explorer',
        replacement: resolve(__dirname, '../../packages/file-explorer/src'),
      },
      {
        find: '@brainstrike/file-explorer-hooks',
        replacement: resolve(__dirname, '../../packages/file-explorer-hooks/src'),
      },
      {
        find: '@brainstrike/file-explorer-ui',
        replacement: resolve(__dirname, '../../packages/file-explorer-ui/src'),
      },
      { find: '@brainstrike/workers', replacement: resolve(__dirname, '../../packages/workers') },
      {
        find: '@brainstrike/workers/file-content-worker',
        replacement: resolve(__dirname, '../../packages/workers/file-content-worker.ts'),
      },
    ],
    preserveSymlinks: true,
  },
  // Allow accessing files from the monorepo packages during Vitest runs
  server: {
    fs: { allow: [resolve(__dirname, '../..')] },
  },
});
