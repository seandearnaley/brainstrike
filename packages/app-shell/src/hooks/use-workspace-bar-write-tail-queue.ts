/**
 * The thread-folder write queue's tail-retirement state, extracted out of
 * `use-workspace-bar.ts` purely to stay under Biome's file-line cap — the
 * same reason `use-workspace-bar-write-derive.ts` and
 * `use-workspace-bar-duplicate-path-notice.ts` exist. `enqueueThreadFoldersWrite`
 * (still in `use-workspace-bar.ts`) is this hook's only caller, and its own
 * doc comment carries the full "why" for the retirement rule this file
 * mechanically implements (BST-1400 item 2, and item 2's review fold-in).
 */
import { type RefObject, useCallback, useRef } from 'react';
import type { FolderWriteIdentity, ThreadFoldersWriteTail } from './use-workspace-bar-write-derive';
import { sameFolderWriteIdentity } from './use-workspace-bar-write-derive';

export interface WriteTailQueue {
  /** `liveIdentityRevisionRef.current`, for a write to snapshot as its own start-of-write bar. */
  readonly currentRevision: () => number;
  readonly pendingWriteCountRef: RefObject<number>;
  /**
   * Feeds one freshly-resynced `threadFoldersRef` identity in. Bumps the
   * revision counter only when it genuinely differs from the last-known
   * identity — a resync that leaves the write-relevant fields unchanged
   * (e.g. only resolved-secondary-root display metadata settling) must not
   * count as a catch-up.
   */
  readonly recordLiveIdentity: (identity: FolderWriteIdentity) => void;
  /**
   * Retires `writeTailRef` once the queue has drained AND the identity
   * revision has advanced past whatever `setRetireAfterRevision` last
   * recorded. Safe to call opportunistically (sync effect, settle handler) —
   * it is a no-op unless both conditions hold.
   */
  readonly retireWriteTailIfCaughtUp: () => void;
  /**
   * One queued write's full settle bookkeeping: drains the pending count,
   * records `revisionAtStart` (captured where the write read `live`) as the
   * bar its own tail must clear, then retires opportunistically — the fast
   * path where `threadFoldersRef` already moved past it by settle time.
   */
  readonly settleWrite: (revisionAtStart: number) => void;
  readonly writeTailRef: RefObject<Promise<ThreadFoldersWriteTail | null> | null>;
}

export function useWriteTailQueue(): WriteTailQueue {
  const writeTailRef = useRef<Promise<ThreadFoldersWriteTail | null> | null>(null);
  const pendingWriteCountRef = useRef(0);
  // How many times threadFoldersRef's write-relevant identity has actually
  // CHANGED, not how many times the sync effect has run — some runs are
  // resolved-secondary-root METADATA settling (display name/path) with the
  // id set itself unchanged, which must not count as a catch-up.
  const liveIdentityRevisionRef = useRef(0);
  const lastKnownIdentityRef = useRef<FolderWriteIdentity | null>(null);
  // The identity revision in effect when the most recently settled write
  // STARTED deriving — the bar `liveIdentityRevisionRef` must clear for the
  // tail to retire. `null` means no write has started one yet (nothing to
  // wait for).
  const retireAfterRevisionRef = useRef<number | null>(null);

  const recordLiveIdentity = useCallback((identity: FolderWriteIdentity) => {
    if (
      lastKnownIdentityRef.current === null ||
      !sameFolderWriteIdentity(lastKnownIdentityRef.current, identity)
    ) {
      lastKnownIdentityRef.current = identity;
      liveIdentityRevisionRef.current += 1;
    }
  }, []);

  const retireWriteTailIfCaughtUp = useCallback(() => {
    const retireAfter = retireAfterRevisionRef.current;
    if (
      pendingWriteCountRef.current === 0 &&
      (retireAfter === null || liveIdentityRevisionRef.current > retireAfter)
    ) {
      writeTailRef.current = null;
    }
  }, []);

  const settleWrite = useCallback(
    (revisionAtStart: number) => {
      pendingWriteCountRef.current -= 1;
      retireAfterRevisionRef.current = revisionAtStart;
      retireWriteTailIfCaughtUp();
    },
    [retireWriteTailIfCaughtUp]
  );

  // Stable identity, same reason as the other exports below: consumed by
  // enqueueThreadFoldersWrite's own useCallback, so a fresh function every
  // render would either churn that callback's identity every render (if
  // added to its deps) or count as a real missing dependency (if not).
  const currentRevision = useCallback(() => liveIdentityRevisionRef.current, []);

  return {
    currentRevision,
    pendingWriteCountRef,
    recordLiveIdentity,
    retireWriteTailIfCaughtUp,
    settleWrite,
    writeTailRef,
  };
}
