import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true, // Optional, but often used
    setupFiles: ['../../vitest.setup.ts'], // Reference the root setup file
  },
}); 
