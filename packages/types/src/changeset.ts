/** Shared contracts for the Changeset Diff Viewer engine (spec: docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md §3). */

import type { GitWorktreeSummary } from './git.ts';

/** A repository keyed by its main-worktree realpath — stable identity across linked worktrees. */
export interface RepositoryIdentity {
  readonly gitCommonDir: string;
  /** Main worktree path (realpath). The stable key. */
  readonly repositoryRoot: string;
}

/** How a worktree became known to the inventory. */
export type WorktreeProvenance = 'agent-reported' | 'both' | 'scanned';

export interface WorktreeDescriptor extends GitWorktreeSummary {
  /** Workspace root ids containing this worktree, or 'outside-roots' when none do. */
  readonly containment: readonly string[] | 'outside-roots';
  readonly provenance: WorktreeProvenance;
  /**
   * Trust state of this descriptor. This answers "is this path safe to
   * touch", NOT "does this repository actually own this worktree" — the two
   * come apart for an in-root entry (see below).
   *
   * A worktree INSIDE a workspace root is always `'validated'` — but that
   * means only "inside a user-granted root", not "ownership verified": the
   * bidirectional check below is skipped entirely for it (the rationale is
   * that the user already trusted everything under the root), so a
   * fabricated `.git/worktrees/<name>/gitdir` pointing at a path INSIDE a
   * root (e.g. another repo's own worktree in the same workspace) still
   * reads `'validated'` here without ever being cross-checked against that
   * target's own `.git`.
   *
   * A worktree whose containment is `'outside-roots'` is `'validated'` only
   * when its own `.git` was read back and resolves to the SAME repository
   * common dir — that IS a genuine bidirectional ownership check — otherwise
   * `'unvalidated'` (e.g. a fabricated `.git/worktrees/<name>/gitdir`
   * pointing outside every root, whose target does not point back). An
   * unvalidated entry is still reported, never silently dropped.
   */
  readonly trust: 'unvalidated' | 'validated';
  /**
   * Why {@link trust} is what it is, for an operator debugging an unexpected
   * `unvalidated` worktree. Null when `trust` is `'validated'` (nothing to
   * explain) OR when the worktree is in-root and the check was never run.
   * Non-null only for an outside-roots worktree whose bidirectional check
   * failed to resolve or resolved to the wrong common dir.
   */
  readonly trustReason: string | null;
}

export interface GitInventoryRepository {
  readonly identity: RepositoryIdentity;
  readonly worktrees: readonly WorktreeDescriptor[];
}

/** Snapshot of every repository + worktree discovered across the active workspace roots. */
export interface GitInventory {
  /** Visible per-repo failures; a broken repo is reported here, never silently omitted. */
  readonly errors: readonly string[];
  readonly repositories: readonly GitInventoryRepository[];
}

/**
 * One `changes:invalidated` push event (BST-1161, spec §6): the main-process
 * git-metadata watcher observed external git activity (terminal commit, fetch,
 * worktree add, …) on a repository. Renderer consumers refetch — the event
 * carries identity, never payload data.
 */
export interface ChangesInvalidationEvent {
  /**
   * Monotonic per-main-process send counter. Consumers keep the highest value
   * seen and drop stale/duplicate deliveries.
   */
  readonly generation: number;
  /** The invalidated repository's git common dir (the watcher's key). */
  readonly gitCommonDir: string;
  /**
   * The repository's main-worktree realpath ({@link RepositoryIdentity}), or
   * null when the service could not map the common dir (e.g. no snapshot
   * yet). Null means "some repository" — consumers refetch conservatively.
   */
  readonly repositoryRoot: string | null;
}

/** Discriminated git diff scope. Each kind carries only the fields it needs (spec §3). */
export type GitScope =
  | {
      /**
       * Base ref to merge-base against; defaults to the repository's default
       * branch (origin/HEAD resolution) when omitted. Resolution is
       * implemented by the changeset resolver (W3).
       */
      readonly baseRef?: string;
      readonly kind: 'branch-vs-base';
    }
  | {
      readonly commitId: string;
      readonly kind: 'commit';
    }
  | {
      readonly kind: 'staged';
    }
  | {
      readonly kind: 'uncommitted';
    }
  | {
      readonly kind: 'unstaged';
    };

export type Changeset =
  | {
      readonly kind: 'agent-run';
      readonly runId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: 'git-scope';
      readonly repositoryRoot: string;
      readonly scope: GitScope;
      readonly worktreePath: string;
    }
  | {
      readonly kind: 'run-range';
      readonly fromRunId: string;
      readonly threadId: string;
      readonly toRunId?: string;
    };

export type ChangedFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export interface ChangedFileEntry {
  /** Line additions, or null when not computable (binary). */
  readonly additions: number | null;
  readonly deletions: number | null;
  /** Previous path for renames. */
  readonly oldPath?: string;
  /**
   * Git's complete unified diff for this one file (ADR-0036), the same text
   * its {@link StructuredFileDiff} carries, so the view draws every file
   * without another request. Null when there is no text diff to draw (a
   * binary file) or when the view's patches reached their bound before this
   * file; such a file loads its {@link StructuredFileDiff} on demand.
   */
  readonly patch: string | null;
  /** Path relative to the owning worktree root. */
  readonly path: string;
  readonly repositoryRoot: string | null;
  readonly revertible: boolean;
  /** Owning workspace root id (durable RootId), or null when outside all roots. */
  readonly rootId: string | null;
  readonly status: ChangedFileStatus;
  /**
   * ADDITIVE view-level attribution metadata (W7 snapshot engine, BST-1164):
   * `true` when a settled host run's committed log records an
   * assistant-tool edit touching this path within the changeset's range;
   * `false` when the snapshot engine captured the change with no tool record
   * (e.g. a shell side effect of an executed command). ABSENT (undefined)
   * when no attribution join ran at all: every `git-scope` changeset, and
   * the LIVE mid-turn view (which deliberately performs no database reads —
   * the BST-1169 starvation rule). Renderers must treat absent as "no badge",
   * never as `false`.
   */
  readonly toolAttributed?: boolean;
  readonly worktreePath: string | null;
}

/**
 * Eager resolution of a Changeset: file list + stats. Per-file diffs load
 * lazily.
 *
 * `totalAdditions`/`totalDeletions` are `number | null` — NOT a sentinel
 * `0` — because "not computable" and "computed to exactly zero" are
 * different facts and this project's settled house rule is
 * make-invalid-states-unrepresentable (the same reasoning that keeps
 * `ChangedFileEntry.additions`/`.deletions` nullable per-file, rather than
 * coercing a binary file's unknown line count to `0`).
 *
 * - `null` ⇒ the changeset's source cannot report totals at all. Today this
 *   is EVERY journal-backed changeset (`agent-run`/`run-range`): the edit
 *   checkpoint journal never records line counts, so there is nothing to
 *   sum.
 * - A `git-scope` changeset ALWAYS computes real totals from `git diff
 *   --numstat` and is therefore NEVER `null` — including when every changed
 *   file is binary, which correctly totals `0`/`0` (a real computed zero,
 *   not "unknown"). A binary file's own `null` per-file
 *   `additions`/`deletions` are EXCLUDED from the sum (never coerced to
 *   `0`) — that per-file exclusion is what produces the real `0` total when
 *   ALL files are binary, and it is a DIFFERENT fact from a journal
 *   changeset's `null` total.
 */
export interface ChangesetView {
  readonly changeset: Changeset;
  readonly files: readonly ChangedFileEntry[];
  readonly totalAdditions: number | null;
  readonly totalDeletions: number | null;
}

/**
 * One file's diff (ADR-0036). Git computes it once; `patch` is git's own
 * unified diff for this one file (`diff --git` header included), and the
 * renderer draws it without diffing again, so the drawn lines always match
 * the file's `additions`/`deletions`.
 */
export type StructuredFileDiffContent =
  | {
      readonly kind: 'binary';
    }
  | {
      readonly kind: 'full';
      /** Full file text at the new side, or null when the side is absent (deleted). */
      readonly newContent: string | null;
      /** Full file text at the old side, or null when the side is absent (added/untracked). */
      readonly oldContent: string | null;
      /** Git's complete unified diff between the two sides. */
      readonly patch: string;
    }
  | {
      readonly kind: 'hunks-only';
      /**
       * Git's unified diff, ending after the last whole hunk that fits the
       * output bound, so it always parses.
       */
      readonly patch: string;
      /** True when hunks were left off the end of `patch`. */
      readonly patchTruncated: boolean;
      /**
       * `'diff-overflow'`: the unified diff itself exceeded the output bound
       * while neither side exceeded the per-file content cap. The
       * `over-cap-*` reasons name a side too large to inline.
       */
      readonly reason: 'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old';
    };

export interface StructuredFileDiff {
  readonly additions: number | null;
  readonly content: StructuredFileDiffContent;
  readonly deletions: number | null;
  readonly oldPath?: string;
  readonly path: string;
  readonly status: ChangedFileStatus;
}

/** Params for the per-file structured diff (git-scope sources; journal sources are W3). */
export type StructuredFileDiffParams =
  | {
      /** Full git object id (40-64 hex chars) — never a symbolic ref; the
       * engine never resolves refs itself. */
      readonly commitId: string;
      /** Diffs `<commitId>^` vs `<commitId>` for ONE path. A root commit
       * (no parent) falls back to git's empty-tree object id as the old
       * side, yielding an `added` file with `oldContent: null` rather than
       * an error. For a MERGE commit `^` is the FIRST parent, so this is a
       * first-parent diff: changes that
       * arrived via the merged branch show
       * as the merge's own changes, and mainline changes between the
       * merge-base and the merge show as no difference. */
      readonly mode: 'commit';
      readonly path: string;
    }
  | {
      /** An ALREADY-RESOLVED ref (a SHA, branch name, tag, or the
       * empty-tree object id) — the caller resolves `origin/HEAD`,
       * merge-base, or the unborn-HEAD empty-tree case; the engine never
       * resolves refs itself. */
      readonly baseRef: string;
      /** Diffs `baseRef` vs the new side (HEAD's committed blob — see
       * `git-structured-diff-refs.ts`/`git-structured-diff.ts` for why the
       * new side is HEAD rather than the live worktree: it must stay
       * consistent with the `branch-vs-base` scope's own numstat listing,
       * which likewise compares committed state via a three-dot merge-base
       * diff, not uncommitted local edits) for ONE path. A path added since
       * `baseRef` has `oldContent: null`. */
      readonly mode: 'range';
      readonly path: string;
    }
  | {
      readonly mode: 'staged';
      readonly path: string;
    }
  | {
      readonly mode: 'untracked';
      readonly path: string;
    }
  | {
      /** Diffs the INDEX vs the worktree (`:0:./<path>` vs the live file) for
       * ONE path — the per-file counterpart to the `unstaged` git-scope's own
       * LISTING comparison (`git diff` with no ref args), so a file's listed
       * additions/deletions and its rendered diff can never disagree (review
       * finding, BST-1113: the `unstaged` scope used to map its per-file diff
       * to `working` (HEAD vs worktree), a DIFFERENT comparison than its own
       * index-vs-worktree listing — for a file with both staged and unstaged
       * edits the two visibly contradicted each other). */
      readonly mode: 'unstaged';
      readonly path: string;
    }
  | {
      readonly mode: 'working';
      readonly path: string;
    };
