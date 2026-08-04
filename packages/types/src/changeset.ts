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
      /** Base ref to merge-base against; defaults to the branch upstream (@{u}) when omitted. */
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

/** Eager resolution of a Changeset: file list + stats. Per-file diffs load lazily. */
export interface ChangesetView {
  readonly changeset: Changeset;
  readonly files: readonly ChangedFileEntry[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
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
  /** Absolute-line hunk ranges; empty for binary. */
  readonly hunks: readonly StructuredDiffHunk[];
  readonly oldPath?: string;
  readonly path: string;
  readonly status: ChangedFileStatus;
}

/** Params for the per-file structured diff (git-scope sources; journal sources are W3). */
export type StructuredFileDiffParams =
  | {
      readonly mode: 'staged';
      readonly path: string;
    }
  | {
      readonly mode: 'untracked';
      readonly path: string;
    }
  | {
      readonly mode: 'working';
      readonly path: string;
    };
