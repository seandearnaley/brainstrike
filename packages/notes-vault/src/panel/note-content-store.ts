import { createLogger } from '@brainstrike/utils';
import type { VaultFileHandleLike } from '../core/types';

const logger = createLogger('NotesVaultViewer');

export type NoteContentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; error: string };

export const NOTE_CONTENT_IDLE: NoteContentState = { status: 'idle' };
const NOTE_CONTENT_LOADING: NoteContentState = { status: 'loading' };

/** Session-lived read cache keyed by `${noteId}@${lastModified}` — an
 * externally edited note gets a new key via the watcher rescan, so stale
 * content can never be served. Bounded; oldest entries evict first. */
const MAX_CACHED_NOTES = 32;
const entries = new Map<string, NoteContentState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function evictOldest(): void {
  while (entries.size > MAX_CACHED_NOTES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest);
  }
}

/**
 * FACTORY RESET CONTRACT: drops all cached note plaintext. Wired into
 * resetNotesVaultSessionState — the zustand store reset alone would leave up
 * to MAX_CACHED_NOTES notes' content in memory on the reset-without-reload
 * web path.
 */
export function clearNoteContentCache(): void {
  entries.clear();
  emit();
}

export function subscribeNoteContent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNoteContentSnapshot(contentKey: string | null): NoteContentState {
  if (contentKey === null) {
    return NOTE_CONTENT_IDLE;
  }
  return entries.get(contentKey) ?? NOTE_CONTENT_LOADING;
}

/**
 * Idempotent load kick-off: the first caller for a key starts the file read.
 * Error entries are NOT sticky — a later ensure for the same key retries, so
 * a transient failure (file briefly locked) recovers on the next selection
 * instead of pinning until lastModified changes.
 */
export function ensureNoteContent(contentKey: string, handle: VaultFileHandleLike): void {
  const existing = entries.get(contentKey);
  if (existing && existing.status !== 'error') {
    return;
  }
  entries.set(contentKey, NOTE_CONTENT_LOADING);
  handle
    .getFile()
    .then((file) => file.text())
    .then(
      (content) => {
        entries.set(contentKey, { content, status: 'ready' });
        evictOldest();
        emit();
      },
      (error: unknown) => {
        logger.error('Reading note failed', { contentKey, error });
        entries.set(contentKey, {
          error: error instanceof Error ? error.message : String(error),
          status: 'error',
        });
        // Failed reads count against the bound too — errors must not grow
        // the cache past MAX_CACHED_NOTES.
        evictOldest();
        emit();
      }
    );
}
