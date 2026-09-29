import {
  createDatabaseIntegrityWatcher,
  type DatabaseIntegrityWatcher,
  getDesktopDatabaseIntegrityBridge,
} from '@brainstrike/db';

/** The host-lifetime view: callers read and wait, and nobody can dispose it. */
export type EmbeddingHostIntegrityWatcher = Omit<DatabaseIntegrityWatcher, 'dispose'>;

let watcher: EmbeddingHostIntegrityWatcher | null = null;

/**
 * The embedding host's one view of the main-owned database integrity state
 * (BST-1870), created on first use. Its claim permit parks on it while
 * background work is not admitted, so it lives as long as the host renderer:
 * `dispose` is not handed out, since a disposed singleton would reject every
 * later permit.
 *
 * Fails visibly when the preload did not expose the bridge: a host that cannot
 * see containment must not claim embedding jobs into a database that may be
 * damaged, and it must not guess that it is healthy.
 */
export function getEmbeddingHostIntegrityWatcher(): EmbeddingHostIntegrityWatcher {
  if (watcher) {
    return watcher;
  }
  const bridge = getDesktopDatabaseIntegrityBridge();
  if (!bridge) {
    throw new Error('Desktop embedding host requires the database integrity bridge.');
  }
  const created = createDatabaseIntegrityWatcher(bridge);
  watcher = {
    current: created.current,
    subscribe: created.subscribe,
    waitUntilBackgroundAdmitted: created.waitUntilBackgroundAdmitted,
  };
  return watcher;
}
