/**
 * The thread-folder write queue's tail-retirement state, extracted out of
 * `use-workspace-bar.ts` purely to stay under Biome's file-line cap — the
 * same reason `use-workspace-bar-write-derive.ts` and
 * `use-workspace-bar-duplicate-path-notice.ts` exist. `enqueueThreadFoldersWrite`
 * (still in `use-workspace-bar.ts`) is this hook's only caller, and its own
 * doc comment carries the full "why" for the retirement rule this file
 * mechanically implements (BST-1400 item 2, and its two review fold-ins).
 *
 * PER-DIMENSION revisions (v4), not one scalar (v1–v3): `threadFoldersRef`'s
 * identity is a five-field composite (`FOLDER_WRITE_IDENTITY_FIELDS`), and
 * "has live caught up?" is one question PER FIELD a chained write actually
 * reads off the tail, not one question about the composite. A single
 * scalar — bumped on ANY field changing, retiring once it moved at all —
 * cannot tell "the dimension THIS write cares about caught up" apart from
 * "some UNRELATED dimension changed" (PR #2685 review, item 2 v3: a
 * `primaryRootId` flip mid-session retired the tail while `secondaryRootIds`
 * — what the write actually changed — was still stale, so the next write
 * derived from the stale value and dropped the first write's change). One
 * counter per field fixes this: a write only needs the counters for the
 * fields it actually touched to have moved.
 *
 * The three-case matrix this must satisfy (each has a pinned regression
 * test in `use-workspace-bar-write-tail.test.tsx`):
 *
 * | Case | Ref state | Required |
 * | --- | --- | --- |
 * | v1 | hasn't caught up on the touched field at all | tail HELD |
 * | v2 | a THIRD PARTY changes the SAME field the write touched | tail RETIRES |
 * | v3 | an UNRELATED field changes; the touched field is still stale | tail HELD |
 *
 * Residual this does NOT cover (documented, not papered over): a third-party
 * writer changing a TOUCHED dimension to a DIFFERENT value than the write's
 * own, landing BEFORE the ref absorbs the write's own change on that same
 * field, still retires the tail and drops the write's change — a genuine
 * same-field lost update between this queue and a concurrent external
 * writer. Irreducible here: the tail's remit is serializing THIS hook's own
 * writes, and it has no mechanism to arbitrate against an external writer
 * on the identical field — that needs optimistic concurrency at the
 * persistence layer, a different ticket.
 */
import { type RefObject, useCallback, useRef } from 'react';
import {
  changedFolderWriteIdentityFields,
  FOLDER_WRITE_IDENTITY_FIELDS,
  type FolderWriteIdentity,
  type FolderWriteIdentityField,
  type ThreadFoldersWriteTail,
} from './use-workspace-bar-write-derive';

export type FolderWriteIdentityRevisions = Readonly<Record<FolderWriteIdentityField, number>>;

const ZERO_REVISIONS: FolderWriteIdentityRevisions = {
  checkoutLocalRootId: 0,
  checkoutMode: 0,
  primaryRootId: 0,
  secondaryRootIds: 0,
  threadId: 0,
};

/** Nothing a write ever touched — a skipped/failed write, or a no-op derive. Retires immediately. */
const NO_TOUCHED_FIELDS: ReadonlySet<FolderWriteIdentityField> = new Set();

export interface WriteTailQueue {
  /** A snapshot of every field's revision counter, for a write to capture as its own start-of-write bar. */
  readonly currentRevisions: () => FolderWriteIdentityRevisions;
  readonly pendingWriteCountRef: RefObject<number>;
  /**
   * Feeds one freshly-resynced `threadFoldersRef` identity in. Bumps ONLY
   * the counters for fields that genuinely differ from the last-known
   * identity — a resync that leaves every write-relevant field unchanged
   * (e.g. only resolved-secondary-root display metadata settling) bumps
   * nothing.
   */
  readonly recordLiveIdentity: (identity: FolderWriteIdentity) => void;
  /**
   * Retires `writeTailRef` once the queue has drained AND either the
   * thread changed since the last settled write started, or every field
   * that write's OWN `touched` set names has moved past its start value.
   * Safe to call opportunistically (sync effect, settle handler) — a
   * no-op unless the queue has actually drained.
   */
  readonly retireWriteTailIfCaughtUp: () => void;
  /**
   * One queued write's full settle bookkeeping: drains the pending count,
   * records `revisionsAtStart` (captured where the write read `live`) and
   * `touched` (the fields its own request actually changed — empty for a
   * skipped/failed/no-op write) as the bar its tail must clear, then
   * retires opportunistically — the fast path where `threadFoldersRef`
   * already moved past it by settle time.
   */
  readonly settleWrite: (
    revisionsAtStart: FolderWriteIdentityRevisions,
    touched: ReadonlySet<FolderWriteIdentityField>
  ) => void;
  readonly writeTailRef: RefObject<Promise<ThreadFoldersWriteTail | null> | null>;
}

export function useWriteTailQueue(): WriteTailQueue {
  const writeTailRef = useRef<Promise<ThreadFoldersWriteTail | null> | null>(null);
  const pendingWriteCountRef = useRef(0);
  const liveIdentityRevisionsRef = useRef<FolderWriteIdentityRevisions>(ZERO_REVISIONS);
  const lastKnownIdentityRef = useRef<FolderWriteIdentity | null>(null);
  // The most recently settled write's start-of-write revisions and the
  // fields it touched — the bar `liveIdentityRevisionsRef` must clear,
  // field by field, for the tail to retire. `null` means no write has
  // settled since the tail last retired (nothing to wait for).
  const retireAfterRef = useRef<{
    readonly revisionsAtStart: FolderWriteIdentityRevisions;
    readonly touched: ReadonlySet<FolderWriteIdentityField>;
  } | null>(null);

  const recordLiveIdentity = useCallback((identity: FolderWriteIdentity) => {
    const previous = lastKnownIdentityRef.current;
    lastKnownIdentityRef.current = identity;
    if (previous === null) {
      return;
    }
    const changed = changedFolderWriteIdentityFields(previous, identity);
    if (changed.size === 0) {
      return;
    }
    const next = { ...liveIdentityRevisionsRef.current };
    for (const field of changed) {
      next[field] += 1;
    }
    liveIdentityRevisionsRef.current = next;
  }, []);

  const retireWriteTailIfCaughtUp = useCallback(() => {
    if (pendingWriteCountRef.current !== 0) {
      return;
    }
    const retireAfter = retireAfterRef.current;
    if (retireAfter === null || retireAfter.touched.size === 0) {
      writeTailRef.current = null;
      return;
    }
    const current = liveIdentityRevisionsRef.current;
    const threadSwitched = current.threadId > retireAfter.revisionsAtStart.threadId;
    const touchedFieldsCaughtUp = FOLDER_WRITE_IDENTITY_FIELDS.filter((field) =>
      retireAfter.touched.has(field)
    ).every((field) => current[field] > retireAfter.revisionsAtStart[field]);
    if (threadSwitched || touchedFieldsCaughtUp) {
      writeTailRef.current = null;
    }
  }, []);

  const settleWrite = useCallback(
    (
      revisionsAtStart: FolderWriteIdentityRevisions,
      touched: ReadonlySet<FolderWriteIdentityField>
    ) => {
      pendingWriteCountRef.current -= 1;
      retireAfterRef.current = { revisionsAtStart, touched };
      retireWriteTailIfCaughtUp();
    },
    [retireWriteTailIfCaughtUp]
  );

  // Stable identity, same reason as the other exports below: consumed by
  // enqueueThreadFoldersWrite's own useCallback, so a fresh function every
  // render would either churn that callback's identity every render (if
  // added to its deps) or count as a real missing dependency (if not).
  const currentRevisions = useCallback(() => liveIdentityRevisionsRef.current, []);

  return {
    currentRevisions,
    pendingWriteCountRef,
    recordLiveIdentity,
    retireWriteTailIfCaughtUp,
    settleWrite,
    writeTailRef,
  };
}

export { NO_TOUCHED_FIELDS };
