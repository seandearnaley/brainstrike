import { defineWorkspace } from "vitest/config";

// Defines the Vitest workspace, pointing to configurations for each package/app.
export default defineWorkspace([
  // Each entry can be a path to a config file or an object defining a project
  {
    // Define the test project for the web application
    extends: "./apps/web/vite.config.mts",
    test: {
      // Apply the global setup file to mock console output
      setupFiles: ["./vitest.setup.ts"],
      // You might include other web-specific test settings here
      // environment: 'jsdom', // Example if needed
    },
  },
  {
    // Define the test project for the utils package
    extends: "./packages/utils/vitest.config.mts",
    test: {
      setupFiles: ["./vitest.setup.ts"],
    },
  },
  {
    // Define the test project for the hooks package
    extends: "./packages/hooks/vitest.config.mts",
    test: {
      setupFiles: ["./vitest.setup.ts"],
    },
  },
  {
    // Define the test project for the ui package
    extends: "./packages/ui/vitest.config.mts",
    test: {
      setupFiles: ["./vitest.setup.ts"],
    },
  },
  {
    // Define the test project for the types package
    extends: "./packages/types/vitest.config.mts",
    test: {
      setupFiles: ["./vitest.setup.ts"],
    },
  },
]);