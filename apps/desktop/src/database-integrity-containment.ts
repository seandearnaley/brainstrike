/**
 * Containment side effects (BST-1870): the one place that reacts to the
 * integrity state changing. Node-safe; the composition root wires it once.
 *
 * Only in-flight backfills need an active stop — they are long-running
 * background writers. Everything else is paused passively by the scheduler gate
 * and the owner-level skips. Live subscriptions, windows and the DB host are
 * deliberately left alone: a contained database keeps serving foreground work.
 */
import { isBackgroundDatabaseWorkAdmitted } from '@brainstrike/db';
import type { DesktopDatabaseIntegrity } from './database-integrity-state';

export interface DatabaseIntegrityContainmentOptions {
  readonly cancelAllDesktopEmbeddingBackfills: () => void;
  readonly integrity: Pick<DesktopDatabaseIntegrity, 'subscribe'>;
}

/** Returns the disposer that unsubscribes. */
export function startDatabaseIntegrityContainment({
  cancelAllDesktopEmbeddingBackfills,
  integrity,
}: DatabaseIntegrityContainmentOptions): () => void {
  return integrity.subscribe((snapshot) => {
    // The shared predicate keeps this in step with the scheduler gate: any
    // state that stops admitting background work also stops running backfills.
    if (!isBackgroundDatabaseWorkAdmitted(snapshot.state)) {
      cancelAllDesktopEmbeddingBackfills();
    }
  });
}
