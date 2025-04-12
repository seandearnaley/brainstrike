import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Add other necessary test configurations here if needed (e.g., environment)
    // environment: 'node', // Example: If tests require Node environment
  },
}); 