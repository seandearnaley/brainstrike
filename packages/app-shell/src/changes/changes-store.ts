/**
 * Thin session-only store for the Changes surface's tree state (BST-1114).
 *
 * Deliberately holds ONLY view state that two sibling panes must agree on —
 * which files are checked, and which tree groups are expanded. The changeset
 * itself, its resolved `ChangesetView`, and every per-file diff stay in
 * `useChangeset`/`useGitInventory`, not here: duplicating server-resolved data
 * into a store is how two sources of truth get out of sync.
 *
 * Split ownership: `changed-files-tree.tsx` writes, `changeset-diff-pane.tsx`
 * reads. Neither imports the other.
 *
 * SELECTION SEMANTICS (load-bearing): an EMPTY `selectedFileKeys` means "no
 * explicit selection — render every file in the changeset", not "render
 * nothing". A changeset that genuinely has no files is a different fact, and
 * it is `ChangesetView.files` that reports it. `hasExplicitSelection` exists so
 * consumers state which of the two they mean instead of re-deriving `.size > 0`
 * and getting it backwards.
 */
import type { ChangedFileEntry } from '@brainstrike/types';
import { create } from 'zustand';

/**
 * Stable identity for one changed file across the whole surface.
 *
 * `ChangedFileEntry.path` is relative to its OWNING worktree, so two worktrees
 * of the same repository routinely contain the same `path` — keying on `path`
 * alone would silently collapse them into one row. `worktreePath` is null for
 * every snapshot-sourced (`agent-run`/`run-range`) entry (review finding,
 * BST-1114 — MULTI-ROOT IDENTITY), so `rootId` is included too: it is the
 * only location fact those entries carry, and two roots routinely share a
 * relative path (`changeset-snapshot-view.ts` keys per-root for the same
 * reason). The NUL separator cannot occur in any component, so the encoding
 * is unambiguous.
 */
export function changedFileKey(entry: ChangedFileEntry): string {
  return `${entry.rootId ?? ''}\u0000${entry.worktreePath ?? ''}\u0000${entry.path}`;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export interface ChangesStoreState {
  /** Clear the explicit selection, returning the pane to "render every file". */
  readonly clearSelection: () => void;
  /** Collapsed/expanded tree group ids. Group ids are the tree adapter's own. */
  readonly expandedIds: ReadonlySet<string>;
  /**
   * True when the user has explicitly narrowed the view. Read this rather than
   * `selectedFileKeys.size > 0` so the empty case stays unambiguous.
   */
  readonly hasExplicitSelection: boolean;
  /**
   * Factory-reset entry point (AGENTS.md invariant: "Any new persistent
   * store/state must be wired into factory reset"). Clears BOTH the
   * selection and the expanded-group ids — a stale selection from a wiped
   * changeset can filter every file out of the diff pane, and stale
   * expanded-group ids reference tree nodes that no longer exist.
   */
  readonly reset: () => void;
  /** {@link changedFileKey} values the user checked. Empty ⇒ render everything. */
  readonly selectedFileKeys: ReadonlySet<string>;
  readonly setExpandedIds: (ids: ReadonlySet<string>) => void;
  readonly setSelectedFileKeys: (keys: ReadonlySet<string>) => void;
  readonly toggleExpanded: (id: string) => void;
  readonly toggleFileKey: (key: string) => void;
}

export const useChangesStore = create<ChangesStoreState>((set) => ({
  clearSelection: () => set({ hasExplicitSelection: false, selectedFileKeys: EMPTY_KEYS }),
  expandedIds: EMPTY_KEYS,
  hasExplicitSelection: false,
  reset: () =>
    set({ expandedIds: EMPTY_KEYS, hasExplicitSelection: false, selectedFileKeys: EMPTY_KEYS }),
  selectedFileKeys: EMPTY_KEYS,
  setExpandedIds: (ids) => set({ expandedIds: ids }),
  setSelectedFileKeys: (keys) =>
    set({ hasExplicitSelection: keys.size > 0, selectedFileKeys: keys }),
  toggleExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedIds: next };
    }),
  toggleFileKey: (key) =>
    set((state) => {
      const next = new Set(state.selectedFileKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { hasExplicitSelection: next.size > 0, selectedFileKeys: next };
    }),
}));

/**
 * Files the diff pane should render, in the changeset's own order.
 *
 * Pure (not a hook) so it can be unit-tested and memoized by the caller.
 */
export function selectRenderedFiles(
  files: readonly ChangedFileEntry[],
  selectedFileKeys: ReadonlySet<string>
): readonly ChangedFileEntry[] {
  if (selectedFileKeys.size === 0) {
    return files;
  }
  return files.filter((entry) => selectedFileKeys.has(changedFileKey(entry)));
}
