/**
 * Browser-safe input schemas for the Brainstrike native tools.
 *
 * These are the exact schemas the desktop registry hands to Mastra and
 * `validateToolInput` parses with; they import only their schema library
 * (plus the browser-safe `@brainstrike/types` and this package's own artifact
 * contract).
 * `@brainstrike/agent` re-exports every name from its historical
 * `src/tools/schemas-*.ts` paths. Native input schemas use Effect Schema (ADR-0004).
 */
export * from './effect-tool-input.ts';
export * from './exec-policy-domain.ts';
export * from './provider-null-normalization.ts';
export * from './schemas-artifacts.ts';
export * from './schemas-browser.ts';
export * from './schemas-diagnostics.ts';
export * from './schemas-execution.ts';
export * from './schemas-memory.ts';
export * from './schemas-search.ts';
export * from './schemas-tasks.ts';
export * from './schemas-workspace.ts';
export * from './schemas-worktrees.ts';
export * from './standard-input-schema.ts';
export * from './tool-input-schema.ts';
