/** Shared contracts for the Changeset Diff Viewer engine (spec: docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md §3). */

import type { GitWorktreeSummary } from './git.js';

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
  /** Path relative to the owning worktree root. */
  readonly path: string;
  readonly repositoryRoot: string | null;
  readonly revertible: boolean;
  /** Owning workspace root id (durable RootId), or null when outside all roots. */
  readonly rootId: string | null;
  readonly status: ChangedFileStatus;
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

/** Absolute line ranges from a unified-diff @@ header. */
export interface StructuredDiffHunk {
  readonly newLines: number;
  readonly newStart: number;
  readonly oldLines: number;
  readonly oldStart: number;
}

/**
 * Content payload for one file diff. Explicit states — over-cap and binary are
 * never silently truncated full content (spec §7, §11 Q3).
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
    }
  | {
      readonly kind: 'hunks-only';
      /** Bounded unified hunk text (boundOutput pattern; marker visible when truncated). */
      readonly hunkText: string;
      readonly hunkTextTruncated: boolean;
      /**
       * `'diff-overflow'`: the unified diff invocation itself exceeded the
       * runner's output buffer while NEITHER side individually exceeded the
       * per-file content cap (e.g. many small scattered edits across two
       * large-but-under-cap files) — distinct from the `over-cap-*` reasons,
       * which name a SIDE that is itself too large to inline.
       */
      readonly reason: 'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old';
    };

export interface StructuredFileDiff {
  readonly additions: number | null;
  readonly content: StructuredFileDiffContent;
  readonly deletions: number | null;
  /**
   * Absolute-line hunk ranges — populated ONLY when a git unified diff was
   * actually computed for this file; empty otherwise. That covers three
   * cases, all legitimate, none dishonest: binary content (no line-level
   * diff is meaningful), an `untracked` whole-file addition (git-scope
   * `structuredFileDiff`'s `untracked` mode never runs a two-sided `git
   * diff`, so there is no unified diff to parse hunks from), and every
   * journal-sourced diff (`agent-run`/`run-range` — the old side is a raw
   * DB-stored string, not a git ref, so there is no git invocation to
   * produce hunk ranges from at all; see `changeset-journal-view.ts`'s
   * `assembleJournalDiff`). A `full` `content` payload with empty `hunks` is
   * NOT a contradiction — `full` only promises both sides' complete text,
   * never that hunk ranges were computed.
   */
  readonly hunks: readonly StructuredDiffHunk[];
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
       * first-parent diff (matching the `commitDiff` IPC precedent in
       * `git-history.ts`): changes that arrived via the merged branch show
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
