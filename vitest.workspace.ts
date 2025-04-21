import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "./apps/web/vite.config.mts",          // web app (Vite acts as Vitest config)
  "./packages/utils/vitest.config.mts",
  "./packages/hooks/vitest.config.mts",
  "./packages/ui/vitest.config.mts",
  "./packages/types/vitest.config.mts"
]);
