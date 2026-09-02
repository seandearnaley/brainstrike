import { lazy } from 'react';

/**
 * Lazy boundary for the E2E-only Tasks harness. Lives in its own
 * component-only module so the export-less renderer entry keeps its Fast
 * Refresh boundary (react-refresh/only-export-components).
 */
export const McpTaskStatusE2eHarness = lazy(() => import('./mcp-task-status-e2e-harness'));
