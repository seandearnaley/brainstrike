import { defineWorkspace } from "vitest/config";

// Defines the Vitest workspace, pointing to configurations for each package/app.
export default defineWorkspace([
  './apps/web/vitest.config.mts',
  './packages/hooks/vitest.config.ts',
  './packages/ui/vitest.config.ts',
  './packages/utils/vitest.config.ts',
  './packages/types/vitest.config.ts',
]);