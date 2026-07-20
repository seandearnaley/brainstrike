import type {
  DirectoryHandle,
  FileSystemAdapter,
  FileSystemWatchSignal,
} from '@brainstrike/file-system';
import { useEventCallback } from '@brainstrike/hooks';
import type { FileSystemChange } from '@brainstrike/types';
import { useEffect, useRef } from 'react';

/** Stable no-op so an absent `onSignal` never churns the dispatcher identity. */
const NOOP_SIGNAL = (_rootId: string, _signal: FileSystemWatchSignal): void => {};

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
 * identity-stable `useEventCallback` wrappers always dispatch to the latest
 * callback without restarting any watcher subscription.
 */
export function useFileSystemWatcher({
  adapter,
  roots,
  onChanges,
  onSignal,
}: UseFileSystemWatcherParams): void {
  // Map<rootId, disposer> — operational infrastructure, never drives UI.
  const watchersRef = useRef<Map<string, () => void>>(new Map());

  // Identity-stable dispatchers that always call the CURRENT callback, so the
  // diff effect can omit them from its deps without restarting watchers.
  //
  // These MUST be commit-phase-fresh, which is exactly what useEventCallback
  // guarantees (it syncs its ref in a layout effect). Watcher events arrive
  // from a bridge/IPC push rather than React's scheduler, so they can land
  // after a render commits but before passive effects flush — a plain
  // `useEffect` ref sync would route that whole window to the PREVIOUS
  // callback. Covered by the "commit-phase events" regression test.
  const emitChanges = useEventCallback(onChanges);
  const emitSignal = useEventCallback(onSignal ?? NOOP_SIGNAL);

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
            emitChanges(rootId, changes);
          },
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
    // emitChanges/emitSignal are listed for accuracy, not because a linter
    // checks it (react-hooks/exhaustive-deps is off repo-wide). Their
    // identities are fixed for the hook's lifetime, so they never actually
    // retrigger this effect. Listing the raw onChanges/onSignal instead would
    // restart every watcher on each callback identity change for no
    // behavioural benefit.
  }, [adapter, roots, emitChanges, emitSignal]);

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
