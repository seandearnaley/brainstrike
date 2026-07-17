import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultNoteNode } from '../core/types';
import { writeNoteFile } from '../core/write-note';
import { invalidateNoteContent } from './note-content-store';

const logger = createLogger('NotesVaultEditor');

/**
 * Per-note write serialization (module scope: detached flushes outlive the
 * component). writeNoteFile is atomic-replace, so without ordering a slow
 * detached flush from a previous edit session could close LAST and clobber a
 * newer save on the same note. Chaining per noteId makes the last-initiated
 * write the last to close.
 */
const pendingWritesByNoteId = new Map<string, Promise<void>>();

function enqueueNoteWrite(noteId: string, write: () => Promise<void>): Promise<void> {
  const previous = pendingWritesByNoteId.get(noteId) ?? Promise.resolve();
  // Run regardless of the previous write's outcome; each caller observes only
  // its own failure.
  const next = previous.then(write, write);
  pendingWritesByNoteId.set(noteId, next);
  const cleanup = () => {
    if (pendingWritesByNoteId.get(noteId) === next) {
      pendingWritesByNoteId.delete(noteId);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

export type NoteSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface UseNoteEditorArgs {
  /** Debounce after the last keystroke before autosave fires. */
  autosaveMs?: number;
  /** The note's on-disk content once loaded; null while loading/absent. */
  diskContent: string | null;
  note: VaultNoteNode | null;
  /** Fired when a detached flush (note switch/unmount) fails — the editor UI
   * is already gone, so the host must surface it (e.g. the alert banner). */
  onDetachedSaveError?: (noteName: string, message: string) => void;
  /** Fired after every successful write (e.g. refresh the tree's mtimes). */
  onSaved?: () => void;
  /**
   * The store's last rename remap (old id/prefix → new). Lets the editor
   * recognize "same note, new identity" — after a rename of the note or an
   * ancestor folder, the buffer is REBOUND (draft preserved) instead of
   * detach-flushed through the pre-rename handle, whose desktop path is
   * stale and now refused by the write layer.
   */
  renameRemap?: { readonly from: string; readonly to: string } | null;
}

/** Remaps a node id after a rename: exact match and descendants (`/`-aware). */
function remapNoteId(id: string, from: string, to: string): string {
  if (id === from) {
    return to;
  }
  if (id.startsWith(`${from}/`)) {
    return `${to}${id.slice(from.length)}`;
  }
  return id;
}

export interface NoteEditorApi {
  beginEdit: () => void;
  draft: string;
  editing: boolean;
  /** Flushes any dirty draft, then leaves edit mode. */
  endEdit: () => Promise<void>;
  error: string | null;
  /** Disk changed under a dirty buffer — the draft is preserved, user decides. */
  externallyChanged: boolean;
  save: () => Promise<void>;
  saveState: NoteSaveState;
  updateDraft: (value: string) => void;
}

interface EditorBuffer {
  baseline: string;
  draft: string;
  handle: VaultNoteNode['handle'];
  noteId: string;
  noteName: string;
}

/**
 * Editing brain for the note viewer: owns the draft buffer, autosave, and
 * reconciliation with external disk changes. Writes are atomic
 * (writeNoteFile) and failures surface as saveState 'error' with the draft
 * preserved. A clean buffer adopts external edits; a dirty buffer keeps the
 * user's work and raises `externallyChanged` instead of clobbering either
 * side. Switching notes (or unmounting) flushes a dirty draft to disk.
 */
export function useNoteEditor({
  note,
  diskContent,
  autosaveMs = 1000,
  onDetachedSaveError,
  onSaved,
  renameRemap = null,
}: UseNoteEditorArgs): NoteEditorApi {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState<NoteSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [externallyChanged, setExternallyChanged] = useState(false);

  const bufferRef = useRef<EditorBuffer | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onDetachedSaveErrorRef = useRef(onDetachedSaveError);
  onDetachedSaveErrorRef.current = onDetachedSaveError;

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  /** Writes the given buffer; used for both live saves and detached flushes.
   * Returns null on success, the failure message otherwise. */
  const writeBuffer = useCallback(async (buffer: EditorBuffer): Promise<string | null> => {
    try {
      await enqueueNoteWrite(buffer.noteId, () => writeNoteFile(buffer.handle, buffer.draft));
      buffer.baseline = buffer.draft;
      // Coarse-mtime filesystems can bucket two saves under one lastModified;
      // dropping the cached entry guarantees the next read hits disk.
      invalidateNoteContent(buffer.noteId);
      onSavedRef.current?.();
      return null;
    } catch (writeError) {
      logger.error('Saving note failed', { error: writeError, noteId: buffer.noteId });
      return writeError instanceof Error ? writeError.message : String(writeError);
    }
  }, []);

  const save = useCallback(async () => {
    const buffer = bufferRef.current;
    if (!buffer || buffer.draft === buffer.baseline) {
      return;
    }
    clearAutosaveTimer();
    setSaveState('saving');
    const failure = await writeBuffer(buffer);
    // Only settle state if this buffer is still the live one.
    if (bufferRef.current === buffer) {
      if (failure === null) {
        setError(null);
        setSaveState(buffer.draft === buffer.baseline ? 'saved' : 'dirty');
      } else {
        setError(`Could not save: ${failure} — your changes are still in the editor.`);
        setSaveState('error');
      }
    }
  }, [clearAutosaveTimer, writeBuffer]);

  // Keep a stable save reference for timers/cleanups.
  const saveRef = useRef(save);
  saveRef.current = save;

  const beginEdit = useCallback(() => {
    if (!note || diskContent === null) {
      return;
    }
    bufferRef.current = {
      baseline: diskContent,
      draft: diskContent,
      handle: note.handle,
      noteId: note.id,
      noteName: note.name,
    };
    setDraft(diskContent);
    setError(null);
    setExternallyChanged(false);
    setSaveState('idle');
    setEditing(true);
  }, [note, diskContent]);

  const updateDraft = useCallback(
    (value: string) => {
      const buffer = bufferRef.current;
      if (!buffer) {
        return;
      }
      buffer.draft = value;
      setDraft(value);
      setSaveState(value === buffer.baseline ? 'saved' : 'dirty');
      clearAutosaveTimer();
      if (value !== buffer.baseline) {
        autosaveTimerRef.current = setTimeout(() => {
          autosaveTimerRef.current = null;
          void saveRef.current();
        }, autosaveMs);
      }
    },
    [autosaveMs, clearAutosaveTimer]
  );

  const endEdit = useCallback(async () => {
    clearAutosaveTimer();
    const buffer = bufferRef.current;
    if (buffer && buffer.draft !== buffer.baseline) {
      await saveRef.current();
    }
    bufferRef.current = null;
    setEditing(false);
    setSaveState('idle');
    setExternallyChanged(false);
  }, [clearAutosaveTimer]);

  // Note switch: flush the previous note's dirty buffer (detached — its
  // handle/draft are captured) and drop out of edit mode. Exception: a RENAME
  // remap means the buffer's note still exists under a new id — rebind it
  // (draft preserved) instead of flushing through the pre-rename handle.
  const noteId = note?.id ?? null;
  useEffect(() => {
    const buffer = bufferRef.current;
    if (!buffer) {
      return;
    }
    if (renameRemap) {
      const remapped = remapNoteId(buffer.noteId, renameRemap.from, renameRemap.to);
      if (remapped !== buffer.noteId) {
        // Same note, renamed (itself or an ancestor). The tree may still be
        // mid-rescan (note transiently null) — keep the buffer alive and let
        // a later pass rebind the fresh handle below.
        buffer.noteId = remapped;
        return;
      }
    }
    if (buffer.noteId === noteId) {
      if (note && buffer.handle !== note.handle) {
        // Post-rescan node: rebind the fresh handle so later saves target the
        // note's CURRENT path (desktop handles bake paths at scan time).
        buffer.handle = note.handle;
        buffer.noteName = note.name;
      }
      return;
    }
    clearAutosaveTimer();
    bufferRef.current = null;
    setEditing(false);
    setSaveState('idle');
    setExternallyChanged(false);
    if (buffer.draft !== buffer.baseline) {
      void writeBuffer(buffer).then((failure) => {
        if (failure !== null) {
          // The editor UI for this note is gone — surface through the host.
          onDetachedSaveErrorRef.current?.(buffer.noteName, failure);
        }
      });
    }
  }, [noteId, note, renameRemap, clearAutosaveTimer, writeBuffer]);

  // External disk change while editing: adopt when clean, flag when dirty.
  useEffect(() => {
    const buffer = bufferRef.current;
    if (!(editing && buffer) || diskContent === null || diskContent === buffer.baseline) {
      return;
    }
    if (buffer.draft === buffer.baseline) {
      buffer.baseline = diskContent;
      buffer.draft = diskContent;
      setDraft(diskContent);
      setExternallyChanged(false);
    } else {
      setExternallyChanged(true);
    }
  }, [diskContent, editing]);

  // Unmount: flush a dirty buffer (detached write; state updates skipped).
  // biome-ignore lint/plugin: unmount-only flush of the draft buffer, not derived state
  useEffect(
    () => () => {
      clearAutosaveTimer();
      const buffer = bufferRef.current;
      if (buffer && buffer.draft !== buffer.baseline) {
        void writeBuffer(buffer).then((failure) => {
          if (failure !== null) {
            onDetachedSaveErrorRef.current?.(buffer.noteName, failure);
          }
        });
      }
    },
    [clearAutosaveTimer, writeBuffer]
  );

  return {
    beginEdit,
    draft,
    editing,
    endEdit,
    error,
    externallyChanged,
    save,
    saveState,
    updateDraft,
  };
}
