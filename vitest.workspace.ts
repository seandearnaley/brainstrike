import { defineWorkspace } from "vitest/config";

// Defines the Vitest workspace, pointing to configurations for each package/app.
export default defineWorkspace([
  './apps/web/vitest.config.mts',
  './packages/hooks/vitest.config.ts',
  './packages/ui/vitest.config.ts',
  './packages/utils/vitest.config.ts',
  './packages/types/vitest.config.ts',
  './packages/test-utils/vitest.config.ts',
  './packages/file-explorer-ui/vitest.config.mts',
  './packages/file-explorer-hooks/vitest.config.ts',
  './packages/file-explorer/package.json',
  './packages/storage/vitest.config.ts',
  './packages/file-system/vitest.config.ts',
  './packages/app-shell/vitest.config.ts',
  './packages/fonts/vitest.config.ts',
  './packages/config/vitest.config.ts',
  './packages/tailwind-config/vitest.config.ts',
  './packages/server-config/package.json',
  './packages/db/vitest.config.ts',
]);
