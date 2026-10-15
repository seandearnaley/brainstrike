/**
 * Browser-safe input schemas for the Brainstrike native tools.
 *
 * These are the exact schemas the desktop registry hands to Mastra and
 * `validateToolInput` parses with; they import only their schema library
 * (plus the browser-safe `@brainstrike/types` and this package's own artifact
 * contract).
 * `@brainstrike/agent` re-exports every name from its historical
 * `src/tools/schemas-*.ts` paths. Newly authored schemas use Effect Schema
 * (ADR-0004, amended 2026-10-15); the rest are still zod.
 */
export * from './effect-tool-input.js';
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
export * from './tool-input-schema.js';
