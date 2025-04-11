import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "./apps/web/vite.config.mts",
  "./packages/utils/vitest.config.mts",
  "./packages/hooks/vitest.config.mts",
  "./packages/ui/vitest.config.mts",
]);
