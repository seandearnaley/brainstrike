import type {
  DirectoryHandle,
  FileSystemAdapter,
  FileSystemWatchSignal,
} from '@brainstrike/file-system';
import type { FileSystemChange } from '@brainstrike/types';
import { useEffect, useRef } from 'react';

export interface FileSystemWatcherRoot {
  handle: DirectoryHandle;
  rootId: string;
}

export interface UseFileSystemWatcherParams {
  adapter: FileSystemAdapter;
  /**
   * Called whenever changes are detected in a watched root.
   * Callers should stabilize this reference (e.g. useCallback) to avoid
   * unnecessary watcher restarts.
   */
  onChanges: (rootId: string, changes: FileSystemChange[]) => void;
  /**
   * Called when a watched root reports an out-of-band health signal
   * ('overflow' = events may have been missed, full refresh required;
   * 'errored' = the watch is dead and already disconnected, must be surfaced
   * visibly). Callers should stabilize this reference (e.g. useCallback).
   */
  onSignal?: (rootId: string, signal: FileSystemWatchSignal) => void;
  /**
   * The set of roots to watch. Keyed by rootId (never by path).
   * Callers should stabilize this array reference (e.g. useMemo) to avoid
   * unnecessary watcher restarts.
   */
  roots: readonly FileSystemWatcherRoot[];
}

/**
 * Maintains a per-root file watcher lifecycle.
 *
 * Diffs the incoming `roots` array on each render:
 * - Starts watchers for roots that are new.
 * - Disposes watchers for roots that have been removed.
 * - Disposes all watchers on unmount.
 *
 * When the adapter does not implement `watchDirectory`, this hook is a no-op.
 *
 * Design note: the watcher map lives in a ref (not state) so mutations never
 * cause re-renders. The diff effect NEVER returns a cleanup — it handles
 * removes inline. A separate unmount-only effect (empty dep array) disposes
 * all watchers when the component is torn down, avoiding the "React tears down
 * and rebuilds on every dep change" pitfall.
 *
 * Documented limitation: changing the `adapter` identity restarts ALL existing
 * watchers for the new adapter instance. This is intentional — a new adapter
 * object represents a distinct filesystem binding. Changing `onChanges` identity
 * alone does NOT restart watchers; the ref update on each render ensures the
 * latest callback is always used without restarting any watcher subscription.
 */
export function useFileSystemWatcher({
  adapter,
  roots,
  onChanges,
  onSignal,
}: UseFileSystemWatcherParams): void {
  // Map<rootId, disposer> — operational infrastructure, never drives UI.
  const watchersRef = useRef<Map<string, () => void>>(new Map());

  // Stable refs so the unmount cleanup can always see the latest values
  // without being listed as deps of the unmount effect.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const onChangesRef = useRef(onChanges);
  onChangesRef.current = onChanges;
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;

  // Diff effect: runs whenever roots/adapter/onChanges changes.
  // Does NOT return a cleanup — disposed roots are handled inline.
  // biome-ignore lint/plugin: watcher subscription setup, not data fetching
  useEffect(() => {
    const watchers = watchersRef.current;
    const watchDirectory = adapter.watchDirectory?.bind(adapter);

    if (!watchDirectory) {
      // Adapter does not support watching; nothing to do.
      return;
    }

    const incomingIds = new Set(roots.map((r) => r.rootId));

    // Dispose watchers for roots that are no longer in the list.
    for (const [rootId, dispose] of watchers) {
      if (!incomingIds.has(rootId)) {
        dispose();
        watchers.delete(rootId);
      }
    }

    // Start watchers for roots that are new.
    for (const { rootId, handle } of roots) {
      if (!watchers.has(rootId)) {
        const dispose = watchDirectory(
          handle,
          (changes) => {
            onChangesRef.current(rootId, changes);
          },
          (signal) => {
            // 'errored' means the adapter already disconnected the watch; the
            // dead disposer stays in the map deliberately — no auto-restart
            // (a silent retry loop would hide the failure). The signal handler
            // is responsible for making the dead watch visible.
            onSignalRef.current?.(rootId, signal);
          }
        );
        watchers.set(rootId, dispose);
      }
    }
    // Intentionally no cleanup return — diff is handled above.
    // onChanges is intentionally excluded: onChangesRef already captures the
    // latest value on every render; listing onChanges here would restart all
    // watchers on every callback identity change without any behavioural benefit.
  }, [adapter, roots]);

  // Unmount-only effect: dispose ALL remaining watchers when the component
  // using this hook is torn down. Empty dep array = runs cleanup once on
  // unmount only.
  useEffect(() => {
    const watchers = watchersRef.current;
    return () => {
      for (const dispose of watchers.values()) {
        dispose();
      }
      watchers.clear();
    };
  }, []);
}
