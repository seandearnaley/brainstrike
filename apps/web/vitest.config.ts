/// <reference types="vitest" />
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.mts'; // Adjust path if necessary

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom', // Or 'happy-dom' based on your setup
      // setupFiles: './src/test/setup.ts', // Removed as it doesn't exist
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html', 'json-summary'], // Added json-summary for better reporting
        reportsDirectory: './coverage',
        exclude: [
          // Add patterns for files/folders to exclude from coverage
          '**/*.config.ts',
          '**/*.config.mts',
          '**/*.config.js',
          '**/__mocks__/**',
          '**/dist/**',
          '**/node_modules/**',
          '**/public/**',
          '**/e2e/**',
          '**/src/main.tsx', // Often excluded as it's mainly setup
          '**/src/test/**',
          '**/src/types/**', // If types directory contains only type definitions
        ],
      },
    },
  })
); 