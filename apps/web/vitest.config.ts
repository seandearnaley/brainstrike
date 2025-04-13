/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Replicate necessary config from vite.config.ts, especially aliases
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			src: path.resolve(__dirname, './src'),
		},
	},
	test: {
		globals: true,
		environment: 'jsdom', // Or 'happy-dom' based on your setup
		// setupFiles: './src/test/setup.ts', // Removed as it doesn't exist
		setupFiles: './src/test/vitest.setup.ts', // Restore setup file
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
}); 