import { defineWorkspace } from "vitest/config";

// Defines the Vitest workspace, pointing to configurations for each package/app.
export default defineWorkspace([
  // Each entry can be a path to a config file or an object defining a project
  {
    // Define the test project for the web application
    // NOTE: We no longer extend the vite config as we define everything here.
    // extends: "./apps/web/vite.config.mts", // Removed this line
    test: {
      // Explicitly set the environment for the web app tests
      environment: "happy-dom",
      // Explicitly enable Vitest global APIs (describe, it, expect, etc.)
      globals: true,
      // Apply the global setup file to mock console output
      setupFiles: ["./vitest.setup.ts"],
      // Specify the files Vitest should consider as tests for this project
      include: ["apps/web/src/**/*.{test,spec}.{ts,tsx}"],
      // Exclude E2E tests and node_modules
      exclude: [
        "apps/web/node_modules/**",
        "apps/web/dist/**",
        "apps/web/e2e/**",
        "apps/web/**/*.e2e.{test,spec}.{ts,tsx}", // Explicitly exclude e2e tests
      ],
      // Optional: Define a name for the project (useful for UI/logs)
      name: "app-web",
      // Use happy-dom for browser-like environment
      // environment: 'jsdom', // Example if needed
    },
    // Resolve aliases from the web app's tsconfig
    resolve: {
      alias: {
        '@/': new URL('./apps/web/src/', import.meta.url).pathname,
      },
    },
  },
  // Define test projects for shared packages
  {
    test: {
      // Explicitly enable Vitest global APIs
      globals: true,
      // Apply the global setup file
      setupFiles: ["./vitest.setup.ts"],
      // Specify files for UI package tests
      include: ["packages/ui/src/**/*.{test,spec}.{ts,tsx}"],
      // Exclude node_modules and dist
      exclude: ["packages/ui/node_modules/**", "packages/ui/dist/**"],
      // Optional: Define a name for the project
      name: "package-ui",
      // Environment for UI components (assuming they need DOM)
      environment: "happy-dom",
    },
    resolve: {
      alias: {
        '@/': new URL('./packages/ui/src/', import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      // Explicitly enable Vitest global APIs
      globals: true,
      // Apply the global setup file
      setupFiles: ["./vitest.setup.ts"],
      // Specify files for hooks package tests
      include: ["packages/hooks/src/**/*.{test,spec}.{ts,tsx}"],
      // Exclude node_modules and dist
      exclude: ["packages/hooks/node_modules/**", "packages/hooks/dist/**"],
      // Optional: Define a name for the project
      name: "package-hooks",
      // Environment for hooks (might need DOM depending on hooks)
      environment: "happy-dom", // Adjust if some hooks are node-only
    },
    resolve: {
      alias: {
        '@/': new URL('./packages/hooks/src/', import.meta.url).pathname,
      },
    },
  },
  // Add similar entries for other packages (utils, types, config) if they have tests
  // Example for utils:
  {
    test: {
      // Explicitly enable Vitest global APIs
      globals: true,
      setupFiles: ["./vitest.setup.ts"],
      include: ["packages/utils/src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["packages/utils/node_modules/**", "packages/utils/dist/**"],
      name: "package-utils",
      environment: "node", // Utils might not need DOM
    },
    resolve: {
      alias: {
        '@/': new URL('./packages/utils/src/', import.meta.url).pathname,
      },
    },
  },
  // ... add other packages as needed
]);