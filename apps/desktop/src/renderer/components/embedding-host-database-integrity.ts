import {
  createDatabaseIntegrityWatcher,
  type DatabaseIntegrityWatcher,
  getDesktopDatabaseIntegrityBridge,
} from '@brainstrike/db';

let watcher: DatabaseIntegrityWatcher | null = null;

/**
 * The embedding host's one view of the main-owned database integrity state
 * (BST-1870), created on first use. Its claim permit parks on it while
 * background work is not admitted.
 *
 * Fails visibly when the preload did not expose the bridge: a host that cannot
 * see containment must not claim embedding jobs into a database that may be
 * damaged, and it must not guess that it is healthy.
 */
export function getEmbeddingHostIntegrityWatcher(): DatabaseIntegrityWatcher {
  if (watcher) {
    return watcher;
  }
  const bridge = getDesktopDatabaseIntegrityBridge();
  if (!bridge) {
    throw new Error('Desktop embedding host requires the database integrity bridge.');
  }
  watcher = createDatabaseIntegrityWatcher(bridge);
  return watcher;
}
