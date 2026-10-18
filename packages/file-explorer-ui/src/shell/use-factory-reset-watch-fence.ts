import {
  hasFactoryResetPreparationStarted,
  registerFactoryResetPreparation,
} from '@brainstrike/app-state/factory-reset';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useRef } from 'react';

const logger = createLogger('FactoryResetWatchFence');

type WatchDirectory = NonNullable<FileSystemAdapter['watchDirectory']>;

// Keep the self-referencing disposer outside React's memoized render closure.
function registerRootWatch(
  activeWatches: Set<() => void>,
  watchDirectory: WatchDirectory,
  ...[handle, callback, onSignal]: Parameters<WatchDirectory>
): () => void {
  let disposed = false;
  const stopWatch = watchDirectory(
    handle,
    (changes, metadata) => {
      if (!disposed) {
        callback(changes, metadata);
      }
    },
    onSignal
      ? (signal) => {
          if (!disposed) {
            onSignal(signal);
          }
        }
      : undefined
  );
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    activeWatches.delete(dispose);
    stopWatch();
  };
  activeWatches.add(dispose);
  return dispose;
}

/**
 * The adapter an owner watches roots through, fenced by factory reset
 * (ADR-0015, BST-2149).
 *
 * Reset preparation is terminal for this renderer. Its live-store clear
 * remounts the explorer, and the roots a restore returns meanwhile are being
 * retired: the next restore that reads the cleared root ledger unmounts them.
 * Preparation therefore fences this owner in the same turn. It disposes the
 * owner's active watches, and the fenced adapter admits no later watch, even
 * one for a restore that was still pending. An owner mounted after
 * preparation began is fenced from the start.
 *
 * Admission is checked when a watch is requested, not when roots render, so
 * a watch effect that flushes after preparation is refused too. A retired
 * watch delivers nothing more to its owner.
 */
export function useFactoryResetWatchFence(adapter: FileSystemAdapter): FileSystemAdapter {
  // The owner calls this hook before it watches, so the effect below fences a
  // remounted owner before the owner's own watch effect runs.
  const fencedRef = useRef(false);
  const activeWatchesRef = useRef(new Set<() => void>());

  const watchAdapter = useMemo((): FileSystemAdapter => {
    const watchDirectory = adapter.watchDirectory?.bind(adapter);
    if (!watchDirectory) {
      return adapter;
    }
    // Delegates every other member to the adapter; only watch admission differs.
    const fencedAdapter: FileSystemAdapter = Object.create(adapter);
    fencedAdapter.watchDirectory = (handle, callback, onSignal) => {
      if (fencedRef.current) {
        logger.debug('Factory reset retired root watching; the root is not watched', {
          path: handle.path,
        });
        return () => undefined;
      }
      return registerRootWatch(
        activeWatchesRef.current,
        watchDirectory,
        handle,
        callback,
        onSignal
      );
    };
    return fencedAdapter;
  }, [adapter]);

  useEffect(() => {
    // An owner remounted after preparation began belongs to the same terminal reset.
    if (hasFactoryResetPreparationStarted()) {
      fencedRef.current = true;
      return;
    }
    return registerFactoryResetPreparation(async () => {
      fencedRef.current = true;
      for (const dispose of [...activeWatchesRef.current]) {
        dispose();
      }
    });
  }, []);

  return watchAdapter;
}
