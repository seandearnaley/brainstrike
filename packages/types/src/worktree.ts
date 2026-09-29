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
  /**
   * `true` exactly when `rootId` is a root whose path IS this checkout's own
   * path (an exact mount) — never a broader root that merely CONTAINS it
   * (the primary checkout inside a larger open folder, or a worktree nested
   * inside another mounted root). `rootId` keeps its existing "first
   * containing root" contract unchanged (bot review, PR #2664 finding 1):
   * this flag is the ADDITIVE signal a consumer needs before treating
   * `rootId` as "this worktree's own workspace root" — e.g. before
   * persisting a root-scoped preference like the background-indexing
   * opt-in, which would otherwise mutate the WRONG root's setting while
   * showing no effect on the checkout actually displayed. Meaningless when
   * `rootId` is `null`.
   */
  readonly rootIdIsExactMount: boolean;
  readonly setupReason: string | null;
  readonly setupStatus: ManagedWorktreeSetupStatus;
  readonly trust: 'unvalidated' | 'validated';
  readonly trustReason: string | null;
  readonly usable: boolean;
}

/** Main-owned worktree settings (Settings → Workspace). */
export type WorktreeSetupCommand = readonly string[] | null | 'disabled';

/** Durable user decision for a repository-committed worktree setup script. */
export type WorktreeRepositorySetupDecision = 'approved' | 'denied';

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
  /** Present only when the repository fallback script needs a durable decision. */
  readonly repositorySetup: {
    readonly repositoryId: string;
    readonly repositoryPath: string;
    readonly scriptPath: string;
    /**
     * SHA-256 of the script's bytes at read time. Consent is pinned to this
     * hash, not just the repository — main re-hashes disk before running the
     * script and refuses a mismatch, so a script that changed after approval
     * (pull / branch switch / rebase) re-prompts instead of silently running
     * under a stale grant.
     */
    readonly scriptSha256: string;
  } | null;
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
  /**
   * Renderer-attested durable choice, pinned to main's resolved repository id
   * AND the script's SHA-256 at decision time. Main re-hashes disk and treats
   * a mismatch as no decision (fail closed to a visible skipped setup).
   */
  readonly repositorySetupDecision?: {
    readonly decision: WorktreeRepositorySetupDecision;
    readonly repositoryId: string;
    readonly scriptSha256: string;
  };
  /** Durable `roots.id` of the checkout the worktree is created FROM. */
  readonly rootId: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}

/**
 * Record an EXISTING on-disk worktree in the ledger (spec §10 "Add as root" /
 * the Mode-chip picker's adoption path). Adoption is what gives an externally
 * created worktree — Claude Code's, Codex's, Cursor's, or one the agent made
 * in a shell — the durable id a thread checkout binds to.
 */
export interface WorktreeAdoptParams {
  readonly createdBy: ManagedWorktreeCreator;
  /** Absolute path of the worktree, as the inventory reports it (realpath'd). */
  readonly path: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}

/**
 * One checkout's working-tree and upstream state, read on demand (spec §10's
 * dirty / ahead-behind glyphs). Deliberately NOT part of `WorktreeListEntry`:
 * `list()` is called on every picker open and every Map refresh, and folding N
 * `git status` subprocesses into it would make an orientation surface expensive.
 */
export interface WorktreeCheckoutStatus {
  /** Commits ahead of upstream, or null when the branch has no upstream. */
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly clean: boolean;
  readonly path: string;
  readonly upstream: string | null;
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

/** Read-only disclosure shown before archive can delete ignored files. */
export interface WorktreeArchivePreview {
  /** Opaque proof binding this worktree to the exact ignored-path set inspected. */
  readonly confirmationToken: string | null;
  readonly ignoredEntryCount: number;
  /** Bounded, sorted top-level paths only; never file contents. */
  readonly ignoredTopLevelEntries: readonly string[];
  readonly ignoredTopLevelEntriesTruncated: boolean;
  /** Total top-level paths represented by the token, including undisplayed paths. */
  readonly ignoredTopLevelEntryCount: number;
}
