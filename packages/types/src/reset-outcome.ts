import type { WorktreeResetOutcome } from './worktree.ts';

/** A scratch folder Clear Database could not move to the Trash. */
export interface ScratchFolderRetained {
  readonly path: string;
  /** Why it stayed, in words that name the folder (the Trash's own refusal, for one). */
  readonly reason: string;
}

/** Clear Database's move of every scratch folder to the system Trash, once the clear succeeded. */
export interface ScratchFolderTrash {
  readonly retained: readonly ScratchFolderRetained[];
  readonly trashed: readonly string[];
}

/** What Clear Database did with the scratch folders, as Main tells the replacement window. */
export type ScratchFolderTrashOutcome =
  /** Each one moved to the Trash, or left on disk and named with why. */
  | (ScratchFolderTrash & { readonly status: 'trashed' })
  /** None could be moved: the folders stay on disk, and this says why. */
  | { readonly reason: string; readonly status: 'failed' };

/**
 * What a reset did with the folders the app made outside its database (ADR-0015, ADR-0034). The
 * window that asked for the reset is replaced before the reset answers it, so Main keeps this and
 * the replacement window takes it once.
 */
export interface ResetOutcome {
  /** The managed worktrees, archived into their repositories before their ledger went. */
  readonly managedWorktrees?: WorktreeResetOutcome;
  /** Factory Reset (`factory`) or Clear Database (`content`). */
  readonly mode: 'content' | 'factory';
  /**
   * Clear Database's scratch folders, moved to the Trash after the clear. Factory Reset deletes
   * userData, and the scratch folders in it, itself.
   */
  readonly scratchFolders?: ScratchFolderTrashOutcome;
}
