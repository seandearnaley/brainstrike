/**
 * Session-only view state for the Changes surface (BST-1114): which tree
 * groups are expanded, and the draft comments on each changeset's diff until
 * they go into a message. The changeset, its `ChangesetView` and every file
 * diff stay in `useChangeset`; duplicating server-resolved data here is how
 * two sources of truth drift apart.
 *
 * Drafts are keyed by changeset, so switching source keeps them. Each draft
 * keeps the file it quotes and the quoted lines, so it reads the same in the
 * message even after a refresh moves or drops that file.
 */
import type { ChangedFileEntry } from '@brainstrike/types';
import type { DiffComment } from '@brainstrike/ui';
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
const NO_DRAFTS: ReadonlyMap<string, readonly DraftComment[]> = new Map();

/** A comment not yet in a message, with the file it was written on. */
export interface DraftComment {
  readonly comment: DiffComment;
  readonly entry: Pick<ChangedFileEntry, 'oldPath' | 'path' | 'rootId'>;
}

export interface ChangesStoreState {
  readonly clearComments: (changesetKey: string) => void;
  /** Draft comments by changeset key, in the order they were written. */
  readonly commentsByChangeset: ReadonlyMap<string, readonly DraftComment[]>;
  readonly deleteComment: (changesetKey: string, id: string) => void;
  /** Collapsed/expanded tree group ids. Group ids are the tree adapter's own. */
  readonly expandedIds: ReadonlySet<string>;
  /** Factory-reset entry point (AGENTS.md invariant). */
  readonly reset: () => void;
  /** Adds a comment, or replaces the one with its id. */
  readonly saveComment: (changesetKey: string, draft: DraftComment) => void;
  readonly setExpandedIds: (ids: ReadonlySet<string>) => void;
  readonly toggleExpanded: (id: string) => void;
}

function withDrafts(
  drafts: ReadonlyMap<string, readonly DraftComment[]>,
  changesetKey: string,
  next: readonly DraftComment[]
): ReadonlyMap<string, readonly DraftComment[]> {
  const copy = new Map(drafts);
  if (next.length === 0) {
    copy.delete(changesetKey);
  } else {
    copy.set(changesetKey, next);
  }
  return copy;
}

export const useChangesStore = create<ChangesStoreState>((set) => ({
  clearComments: (changesetKey) =>
    set((state) => ({
      commentsByChangeset: withDrafts(state.commentsByChangeset, changesetKey, []),
    })),
  commentsByChangeset: NO_DRAFTS,
  deleteComment: (changesetKey, id) =>
    set((state) => ({
      commentsByChangeset: withDrafts(
        state.commentsByChangeset,
        changesetKey,
        (state.commentsByChangeset.get(changesetKey) ?? []).filter(
          (draft) => draft.comment.id !== id
        )
      ),
    })),
  expandedIds: EMPTY_KEYS,
  reset: () => set({ commentsByChangeset: NO_DRAFTS, expandedIds: EMPTY_KEYS }),
  saveComment: (changesetKey, draft) =>
    set((state) => {
      const current = state.commentsByChangeset.get(changesetKey) ?? [];
      const id = draft.comment.id;
      const next = current.some((saved) => saved.comment.id === id)
        ? current.map((saved) => (saved.comment.id === id ? draft : saved))
        : [...current, draft];
      return { commentsByChangeset: withDrafts(state.commentsByChangeset, changesetKey, next) };
    }),
  setExpandedIds: (ids) => set({ expandedIds: ids }),
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
}));
