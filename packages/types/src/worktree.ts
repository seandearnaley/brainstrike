/**
 * Managed-worktree contracts (spec §5.2, §5.3, §6). Shared by desktop main
 * (WorktreeService + the ledger), the `window.worktrees` bridge, and the
 * renderer's Mode chip.
 *
 * Lives in `@brainstrike/types` rather than `@brainstrike/assistant-data`
 * because desktop main keeps workspace packages EXTERNAL in its esbuild bundle
 * and only two audited ESM subpaths are inlined (`build-main-config.test.ts`);
 * `@brainstrike/types` is already a main-process import.
 */
import type { WorktreeProvenance } from './changeset.js';

export const WORKTREE_LEDGER_TABLE = 'brainstrike_worktrees';

/** Who asked for the worktree. Mirrors the ledger CHECK constraint. */
export type ManagedWorktreeCreator = 'agent' | 'user';

/**
 * Outcome of the per-worktree setup step (spec §6.3).
 * `none` = nothing to run; `skipped` = something to run that this platform or
 * configuration refused, with the reason recorded — never a silent no-op.
 */
export type ManagedWorktreeSetupStatus = 'failed' | 'none' | 'skipped' | 'succeeded';

/**
 * One `brainstrike_worktrees` row. `rootId` is DELIBERATELY absent: the durable
 * `roots.id` is derived by path from the live `roots` table at read time, since
 * a stored copy goes stale the moment the user disconnects the folder.
 */
export interface ManagedWorktreeRow {
  readonly archivedAt: string | null;
  /** `refs/brainstrike/worktree-archive/<id>` once archived, else null. */
  readonly archiveSnapshotRef: string | null;
  readonly baseRef: string;
  /** Branch at creation; null for a detached worktree. Display hint only. */
  readonly branch: string | null;
  readonly createdAt: string;
  readonly createdBy: ManagedWorktreeCreator;
  /** uuidv7. */
  readonly id: string;
  readonly path: string;
  /** Realpath'd git common dir — the repository identity the inventory uses. */
  readonly repoCommonDir: string;
  /** The run that created it, when `createdBy === 'agent'`. */
  readonly runId: string | null;
  /** Bounded captured setup output (≤ 16 KiB), or null. */
  readonly setupOutput: string | null;
  readonly setupStatus: ManagedWorktreeSetupStatus;
  /** Owning thread; null for a worktree that outlived (or never had) one. */
  readonly threadId: string | null;
}

/** External tool that owns a scanned worktree path (spec §5.3) — a LABEL, not provenance. */
export type WorktreeExternalTool = 'claude-code' | 'codex' | 'cursor';

/**
 * One row of the Mode chip's existing-worktree picker: the git inventory JOINED
 * with the ledger.
 *
 * NO SILENT HIDING (spec §13): every worktree the inventory reports appears
 * here. `usable: false` always carries `disabledReason`, and `remedy` names the
 * action that would make it usable (or is null when nothing can).
 */
export interface WorktreeListEntry {
  readonly branch: string | null;
  readonly containment: readonly string[] | 'outside-roots';
  readonly detached: boolean;
  /** Non-null exactly when `usable` is false. */
  readonly disabledReason: string | null;
  readonly externalTool: WorktreeExternalTool | null;
  /** Ledger id when managed; null for a purely scanned worktree. */
  readonly id: string | null;
  readonly lockedReason: string | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly provenance: WorktreeProvenance;
  /** The action that would make an unusable row usable, or null. */
  readonly remedy: 'grant-access' | null;
  readonly repositoryRoot: string;
  /** Durable id of the first live workspace root containing this worktree. */
  readonly rootId: string | null;
  readonly trust: 'unvalidated' | 'validated';
  readonly trustReason: string | null;
  readonly usable: boolean;
}

/** Main-owned worktree settings (Settings → Workspace). */
export interface WorktreeSettings {
  /**
   * True when nothing has been persisted for `managedDirectory` — the user has
   * never chosen a custom directory. NOT a path-equality check: explicitly
   * saving a path equal to the default still counts as a custom selection.
   */
  readonly isDefaultDirectory: boolean;
  /** Absolute base directory for managed worktrees [D3]. */
  readonly managedDirectory: string;
  /**
   * argv for the per-worktree setup command. `null` ⇒ use the repository's
   * `.brainstrike/worktree-setup.sh` when present.
   */
  readonly setupCommand: readonly string[] | null;
}

/** `{ detached: true }` [D2] or the branch to create at `baseRef`. */
export type WorktreeBranchRequest = { readonly detached: true } | { readonly name: string };

export interface WorktreeCreateParams {
  readonly baseRef: string;
  readonly branch: WorktreeBranchRequest;
  readonly createdBy: ManagedWorktreeCreator;
  /** Directory name under `<managedDirectory>/<repo-slug>/`. */
  readonly name: string;
  /** Durable `roots.id` of the checkout the worktree is created FROM. */
  readonly rootId: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}

export interface WorktreeSetupOutcome {
  /** Root-relative paths copied because `.worktreeinclude` matched them. */
  readonly copiedPaths: readonly string[];
  /** Captured stdout+stderr, bounded. Empty string when nothing ran. */
  readonly output: string;
  /** Why the status is what it is — non-null for `failed` and `skipped`. */
  readonly reason: string | null;
  readonly status: ManagedWorktreeSetupStatus;
  readonly truncated: boolean;
}

export interface WorktreeCreateResult {
  readonly setup: WorktreeSetupOutcome;
  readonly worktree: ManagedWorktreeRow;
}

export interface WorktreeArchiveResult {
  /** The captured snapshot ref — always present, even for a clean worktree. */
  readonly snapshotRef: string;
  readonly worktree: ManagedWorktreeRow;
}
