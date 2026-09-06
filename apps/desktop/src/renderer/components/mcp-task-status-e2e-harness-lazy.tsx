import { lazy } from 'react';

/**
 * Lazy boundary for the E2E-only Tasks harness, in its own component-only
 * module so the export-less renderer entry keeps its Fast Refresh boundary.
 * The dynamic import exists only when the renderer was built with
 * `VITE_MCP_TASK_HARNESS=1` (the packaged verifier lane sets it at pack time),
 * so release builds never emit the harness chunk or its PGlite/migration
 * closure: "nothing enables Tasks in production" is structural, not a
 * runtime boolean.
 */
export const McpTaskStatusE2eHarness =
  import.meta.env['VITE_MCP_TASK_HARNESS'] === '1'
    ? lazy(() => import('./mcp-task-status-e2e-harness'))
    : null;
