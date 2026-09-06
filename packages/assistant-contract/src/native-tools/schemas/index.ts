/**
 * Browser-safe Zod input schemas for the Brainstrike native tools.
 *
 * These are the exact schemas the desktop registry hands to Mastra and
 * `validateToolInput` parses with; they import only `zod` (plus the
 * browser-safe `@brainstrike/types` and this package's own artifact contract).
 * `@brainstrike/agent` re-exports every name from its historical
 * `src/tools/schemas-*.ts` paths.
 */
export * from './exec-policy-domain.js';
export * from './provider-compatible-input.js';
export * from './schemas-artifacts.js';
export * from './schemas-browser.js';
export * from './schemas-diagnostics.js';
export * from './schemas-execution.js';
export * from './schemas-search.js';
export * from './schemas-tasks.js';
export * from './schemas-workspace.js';
export * from './schemas-worktrees.js';
