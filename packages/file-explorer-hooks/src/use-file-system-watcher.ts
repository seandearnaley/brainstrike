import type {
  DirectoryHandle,
  FileSystemAdapter,
  FileSystemWatchBatchMetadata,
  FileSystemWatchSignal,
} from '@brainstrike/file-system';
import type { FileSystemChange } from '@brainstrike/types';
import { useEffect, useEffectEvent, useRef } from 'react';

export interface FileSystemWatcherRoot {
  handle: DirectoryHandle;
  rootId: string;
}

export interface UseFileSystemWatcherParams {
  adapter: FileSystemAdapter;
  /**
   * Called whenever changes are detected in a watched root. A new reference
   * never restarts a watcher.
   */
  onChanges: (
    rootId: string,
    changes: FileSystemChange[],
    metadata?: FileSystemWatchBatchMetadata
  ) => void;
  /**
   * Called when a watched root reports an out-of-band health signal
   * ('overflow' = events may have been missed, full refresh required;
   * 'errored' = the watch is dead and already disconnected, must be surfaced
   * visibly). A new reference never restarts a watcher.
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
 * Documented limitation: changing the `adapter` identity is currently a NO-OP
 * for roots that are already watched. The effect re-runs, but the diff is keyed
 * purely on `rootId` — the dispose loop finds nothing missing and the start loop
 * finds nothing new — so existing watchers stay bound to the PREVIOUS adapter
 * and the new one never takes over. Unreachable today: the adapter is an
 * app-level singleton from `AdaptersProvider` and its identity never changes.
 * If that ever stops being true, key the diff on `(adapter, rootId)` rather
 * than trusting this comment.
 *
 * Changing `onChanges`/`onSignal` identity does NOT restart watchers; the
 * Effect Events always dispatch to the latest callback without restarting any
 * watcher subscription.
 */
export function useFileSystemWatcher({
  adapter,
  roots,
  onChanges,
  onSignal,
}: UseFileSystemWatcherParams): void {
  // Map<rootId, disposer> — operational infrastructure, never drives UI.
  const watchersRef = useRef<Map<string, () => void>>(new Map());

  // Effect Events always call the CURRENT callback, so the diff effect leaves
  // them out of its deps and a new callback never restarts a watcher.
  //
  // These MUST be commit-phase-fresh, which React guarantees for Effect Events.
  // Watcher events arrive from a bridge/IPC push rather than React's scheduler,
  // so they can land after a render commits but before passive effects flush —
  // a plain `useEffect` ref sync would route that whole window to the PREVIOUS
  // callback. Covered by the "commit-phase events" regression test.
  const emitChanges = useEffectEvent(
    (rootId: string, changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => {
      if (metadata) {
        onChanges(rootId, changes, metadata);
      } else {
        onChanges(rootId, changes);
      }
    }
  );
  const emitSignal = useEffectEvent((rootId: string, signal: FileSystemWatchSignal) => {
    onSignal?.(rootId, signal);
  });

  // Diff effect: runs whenever roots or adapter changes.
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
          (changes, metadata) => emitChanges(rootId, changes, metadata),
          (signal) => {
            // 'errored' means the adapter already disconnected the watch; the
            // dead disposer stays in the map deliberately — no auto-restart
            // (a silent retry loop would hide the failure). The signal handler
            // is responsible for making the dead watch visible.
            emitSignal(rootId, signal);
          }
        );
        watchers.set(rootId, dispose);
      }
    }
    // Intentionally no cleanup return — diff is handled above.
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
