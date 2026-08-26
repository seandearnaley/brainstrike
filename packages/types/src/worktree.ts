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
  /** Bounded captured setup report/output (≤ 32 KiB), or null. */
  readonly setupOutput: string | null;
  /** User-facing reason for a failed or skipped setup, or null. */
  readonly setupReason: string | null;
  readonly setupStatus: ManagedWorktreeSetupStatus;
  /** Owning thread; null for a worktree that outlived (or never had) one. */
  readonly threadId: string | null;
}

/** Ledger-only identity needed by boot-time root reconciliation. */
export interface ManagedWorktreePathEntry {
  readonly id: string;
  readonly path: string;
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
  /** Ledger creation stamp (ISO-8601); null for a purely scanned worktree. */
  readonly createdAt: string | null;
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
  /**
   * True when this checkout is the repository's MAIN worktree, not a linked
   * one. `git worktree list` enumerates it, so it reaches every consumer of
   * this list; the Worktree Map renders it as the lane's first card, and the
   * Mode chip's picker refuses it as a checkout target (a thread that wants
   * the primary checkout is in Local mode, by definition).
   */
  readonly primary: boolean;
  readonly provenance: WorktreeProvenance;
  /** The action that would make an unusable row usable, or null. */
  readonly remedy: 'grant-access' | null;
  /**
   * Realpath'd git common dir — the repository identity `brainstrike_worktrees`
   * and `brainstrike_forge_prs` both key on. Distinct from `repositoryRoot`
   * (the main worktree path): the PR cache joins on THIS.
   */
  readonly repoCommonDir: string;
  readonly repositoryRoot: string;
  /** Durable id of the first live workspace root containing this worktree. */
  readonly rootId: string | null;
  readonly setupReason: string | null;
  readonly setupStatus: ManagedWorktreeSetupStatus;
  readonly trust: 'unvalidated' | 'validated';
  readonly trustReason: string | null;
  readonly usable: boolean;
}

/** Main-owned worktree settings (Settings → Workspace). */
export type WorktreeSetupCommand = readonly string[] | null | 'disabled';

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
   * `.brainstrike/worktree-setup.sh` when present; `'disabled'` ⇒ never run a
   * setup command or probe for the repository fallback.
   */
  readonly setupCommand: WorktreeSetupCommand;
}

/**
 * Live parent-path + suggested-name preview for the create sheet, resolved
 * server-side so the renderer never recomputes the slug or word lists.
 */
export interface WorktreeCreateContext {
  readonly managedParentPath: string;
  readonly suggestedName: string;
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
  /** Bounded copy-refusal report followed by captured stdout+stderr. */
  readonly output: string;
  /** Why the status is what it is — non-null for `failed` and `skipped`. */
  readonly reason: string | null;
  /** Resolved `.worktreeinclude` matches refused before copying, with specific reasons. */
  readonly skippedCopies: readonly WorktreeSetupSkippedCopy[];
  readonly status: ManagedWorktreeSetupStatus;
  readonly truncated: boolean;
}

export interface WorktreeSetupSkippedCopy {
  /** Resolved root-relative glob match that was refused. */
  readonly path: string;
  /** Original `.worktreeinclude` pattern that produced the match. */
  readonly pattern: string;
  readonly reason: string;
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
