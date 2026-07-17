import { useEffect, useSyncExternalStore } from 'react';
import type { VaultNoteNode } from '../core/types';
import {
  ensureNoteContent,
  getNoteContentSnapshot,
  type NoteContentState,
  subscribeNoteContent,
} from './note-content-store';

export type { NoteContentState } from './note-content-store';

/**
 * Loads the selected note's text through the external content cache.
 * The key includes lastModified, so watcher-driven rescans (external edits)
 * refresh the viewer live; unrelated rescans that recreate node objects
 * without changing the file do not re-read it.
 */
export function useNoteContent(note: VaultNoteNode | null): NoteContentState {
  const contentKey = note ? `${note.id}@${note.lastModified}` : null;
  const handle = note?.handle ?? null;

  // biome-ignore lint/plugin: idempotent async file-read kick-off keyed on id+lastModified (data hydration, not an event)
  useEffect(() => {
    if (contentKey !== null && handle !== null) {
      ensureNoteContent(contentKey, handle);
    }
  }, [contentKey, handle]);

  return useSyncExternalStore(subscribeNoteContent, () => getNoteContentSnapshot(contentKey));
}
