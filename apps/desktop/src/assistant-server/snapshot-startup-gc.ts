/**
 * Startup GC over the shadow-git snapshot backbone (BST-1164 T4).
 *
 * Runs once per boot from main.ts's fire-and-forget startup block, AFTER
 * `sweepOrphans` (which removes whole shadow repos whose workspace root row
 * is gone). This module owns everything finer-grained:
 *
 *  1. DEAD-THREAD PURGE — thread ids with `brainstrike_workspace_snapshots`
 *     rows but no `mastra_threads` row lost their thread. The renderer-side
 *     delete cascade (`THREAD_DELETE_SIDECAR_TABLES`) removes rows for
 *     threads deleted through the UI, so anything caught here is legacy
 *     pre-cascade residue or a crashed cascade: rows are deleted and the
 *     per-root `refs/snapshots/<threadId>` lineage refs pruned.
 *  2. REF-ONLY RESIDUE — a `refs/snapshots/<threadId>` ref surviving in a
 *     live root's shadow repo with NO ledger rows backing it (for that root)
 *     anchors objects the app can never resolve again; it is deleted. Refs
 *     are enumerated PER SHADOW REPO via `listSnapshotThreadIds`.
 *     A host thread's turn snapshots are recorded in the host's committed
 *     log, never the ledger, so its ref stays while the host lists the
 *     thread; a deleted host thread's ref is residue. The host is asked once,
 *     only when a ref has no ledger rows, and if it cannot answer every such
 *     ref is kept and the failure reported (refusing beats guessing here too).
 *     Host chains are never among the shallow-cut boundaries, so history
 *     reclamation keeps them whole.
 *  3. RETENTION RING (the plan's GC policy, trigger choice DOCUMENTED here):
 *     keep the newest {@link DEFAULT_SNAPSHOT_TURN_RING} turn brackets per
 *     thread; older ledger rows (including their interleaved `pre-revert`
 *     rows) are deleted. The ring runs in THIS startup sweep, not on
 *     turn-end: the plan pins gc work "idle, never during a run", turn-end
 *     sits between the boundary snapshot and the changeset identity publish
 *     (the BST-1169 hot path), and a boot-time trim bounds growth just as
 *     tightly with zero run-path cost.
 *
 *     OUTSTANDING-REDO FLOOR (invariant, BST-1164 review): the ring trim
 *     never deletes a turn bracket that an OUTSTANDING tombstone batch (a
 *     rewind applied but not yet finalized — its rows still sit in
 *     `brainstrike_assistant_message_tombstones` with a `revert_id`) still
 *     needs for redo. Redo re-derives its turn-start baseline from the
 *     batch's target turn (`resolveRedoRoots` via `resolveEarliestBatchTarget`
 *     + `resolveRewindRunRange`), so trimming that turn's rows — e.g. a
 *     rewind to a turn older than the ring followed by a restart before the
 *     next user message finalizes it — would leave redo refusing
 *     `snapshot-missing` forever while the batch's messages stay hidden. The
 *     trim boundary is therefore FLOORED at the oldest bracket referenced by
 *     any outstanding batch, derived with the SAME durable resolution redo
 *     itself uses; a batch whose target cannot be re-derived skips the
 *     thread's trim entirely (visible failure — refusing beats guessing on a
 *     destructive seam). The shallow-cut boundary respects the same floor by
 *     construction: `survivingChainBoundaries` runs AFTER the trims and cuts
 *     at the oldest SURVIVING row per chain, which the floor just protected.
 *     Once finalization deletes the batch's tombstone rows, the floor
 *     disappears and the next sweep reclaims the bracket.
 *  4. HISTORY RECLAMATION — after any trim/prune in a repo, the surviving
 *     per-thread chain boundaries (oldest remaining non-sentinel oid per
 *     thread per root) are written as git shallow cut points and
 *     `git gc --prune=now` reclaims everything behind them
 *     (`SnapshotService.pruneHistory` — see its doc for the verified
 *     mechanism).
 *
 * FAILURE POSTURE: never blocks startup (caller runs it fire-and-forget),
 * never throws for a single thread/root — each failure is collected into the
 * report's `failures` and the caller logs them VISIBLY.
 *
 * The "mass-delete" guard is intact but no longer needs a probe (BST-1651).
 * It used to `to_regclass` `mastra_threads` first, because that table was
 * created lazily at runtime; migration 117 creates it, and `getDatabase()`
 * resolves only after `migrate()`. The safety property is preserved by
 * ORDER, not by the probe: `listLiveThreadIds` — the only reader of
 * `mastra_threads` — runs BEFORE anything is deleted and is skipped entirely
 * when the ledger is empty, so an unmigrated database raises 42P01 out of
 * this sweep with nothing touched, exactly what the old refusal achieved.
 */
import { access } from 'node:fs/promises';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  WORKSPACE_SNAPSHOTS_TABLE,
} from '@brainstrike/assistant-contract';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { resolveEarliestBatchTarget, resolveRewindRunRange } from './rewind-repository';
import { FAILED_SNAPSHOT_CAPTURE_OID, type SnapshotRepository } from './snapshot-repository';
import type { ShadowRepoHandle, SnapshotService } from './snapshot-service';
import {
  findBracketByRunId,
  resolveSnapshotTurnBrackets,
  type SnapshotTurnBracket,
} from './snapshot-turn-ledger';

const THREADS_TABLE = 'mastra_threads';

/** Production probe backing {@link SnapshotStartupGcDeps.isRootPathAccessible}. */
function isPathAccessible(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

/** The plan's retention ring: newest 50 turns per thread. */
export const DEFAULT_SNAPSHOT_TURN_RING = 50;

export interface SnapshotStartupGcDeps {
  readonly db: EditCheckpointDatabase;
  /**
   * Probe for a root path's existence before opening its shadow repo.
   * Injectable for tests; production defaults to `fs.access`.
   */
  readonly isRootPathAccessible?: (path: string) => Promise<boolean>;
  /** Connected workspace roots (every `roots` row — disconnect ≠ delete). */
  readonly liveRoots: readonly { readonly path: string; readonly rootId: string }[];
  /** The agent host's live thread ids, whose snapshot refs no ledger row backs. */
  readonly readHostThreadIds: () => Promise<ReadonlySet<string>>;
  readonly snapshotRepository: SnapshotRepository;
  readonly snapshotService: SnapshotService;
  /** Ring override for tests; production uses the default. */
  readonly turnRing?: number | undefined;
}

export interface SnapshotStartupGcReport {
  /** Thread ids whose rows + refs were purged (no thread row backs them). */
  readonly deadThreadsPruned: readonly string[];
  /** Per-item failure descriptions — the caller logs each visibly. */
  readonly failures: readonly string[];
  /** Root ids whose shadow repos were shallow-cut + gc'd this sweep. */
  readonly historyPrunedRoots: readonly string[];
  /** Refs deleted because no ledger rows back them in that root. */
  readonly refOnlyPruned: readonly { readonly rootId: string; readonly threadId: string }[];
  /** Per-thread ring trims: how many ledger rows fell off the ring. */
  readonly ringTrimmed: readonly { readonly deletedRows: number; readonly threadId: string }[];
  /**
   * Live roots whose PATH was unreachable (deleted directory, unmounted
   * volume): their shadow repos were left untouched and the caller logs a
   * single warn — this is an expected condition, never a per-boot error.
   */
  readonly skippedInaccessibleRoots: readonly {
    readonly path: string;
    readonly rootId: string;
  }[];
}

interface GcAccumulator {
  readonly deadThreadsPruned: string[];
  readonly failures: string[];
  readonly refOnlyPruned: { rootId: string; threadId: string }[];
  readonly ringTrimmed: { deletedRows: number; threadId: string }[];
  readonly skippedInaccessibleRoots: { path: string; rootId: string }[];
  /** Root ids needing a pruneHistory pass. */
  readonly touchedRoots: Set<string>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's live thread ids, or that the host could not list them. */
type HostThreads =
  | { readonly ids: ReadonlySet<string>; readonly kind: 'listed' }
  | { readonly kind: 'unavailable' };

/**
 * The host's live thread ids, read once per sweep and only when a ref without
 * ledger rows needs the answer.
 */
function hostThreadsReader(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator
): () => Promise<HostThreads> {
  let read: Promise<HostThreads> | undefined;
  return () => {
    read ??= deps.readHostThreadIds().then(
      (ids): HostThreads => ({ ids, kind: 'listed' }),
      (error: unknown): HostThreads => {
        accumulator.failures.push(
          `host thread list unavailable, so unbacked snapshot refs were kept: ${describeError(error)}`
        );
        return { kind: 'unavailable' };
      }
    );
    return read;
  };
}

async function listSnapshotThreadIdsInLedger(db: EditCheckpointDatabase): Promise<string[]> {
  const result = await db.query<{ threadId: string }>(
    `SELECT DISTINCT thread_id AS "threadId" FROM ${WORKSPACE_SNAPSHOTS_TABLE}`
  );
  return result.rows.map((row) => row.threadId);
}

async function listLiveThreadIds(
  db: EditCheckpointDatabase,
  candidateIds: readonly string[]
): Promise<Set<string>> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM ${THREADS_TABLE} WHERE id = ANY($1)`,
    [candidateIds]
  );
  return new Set(result.rows.map((row) => row.id));
}

/**
 * Purge one dead thread: ledger rows first (the source of truth), then the
 * lineage ref in every LIVE root the rows named. Roots that are no longer in
 * the `roots` table are deliberately skipped — `sweepOrphans` owns whole
 * orphaned shadow repos, and `ensureShadowRepo` on a vanished root would
 * CREATE a fresh empty repo as a side effect.
 */
async function purgeDeadThread(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator,
  liveRootsById: ReadonlyMap<string, string>,
  accessibleByRootId: ReadonlyMap<string, boolean>,
  threadId: string
): Promise<void> {
  const roots = await deps.snapshotRepository.rootsForThread(threadId);
  await deps.snapshotRepository.deleteForThread(threadId);
  for (const root of roots) {
    const livePath = liveRootsById.get(root.rootId);
    if (livePath === undefined) {
      continue;
    }
    // Unreachable root path (probed ONCE per sweep): skip the ref prune
    // (recorded once by reconcileRootRepo, which sweeps every live root). The
    // refs become ref-only residue the next sweep reclaims when the root is
    // back.
    if (accessibleByRootId.get(root.rootId) !== true) {
      continue;
    }
    try {
      const handle = await deps.snapshotService.ensureShadowRepo({
        path: livePath,
        rootId: root.rootId,
      });
      await deps.snapshotService.pruneThread(handle, threadId);
      accumulator.touchedRoots.add(root.rootId);
    } catch (error) {
      accumulator.failures.push(
        `dead-thread ref prune failed (thread "${threadId}", root "${root.rootId}"): ${describeError(error)}`
      );
    }
  }
  accumulator.deadThreadsPruned.push(threadId);
}

/** One outstanding (unfinalized) rewind batch with a files restore to redo. */
interface OutstandingRevertBatch {
  readonly messageIds: readonly string[];
  readonly rewindId: string;
}

/**
 * Unfinalized tombstone batches with a `revert_id` — the batches whose redo
 * still depends on ledger rows. Finalization hard-deletes tombstone rows, so
 * presence in this table IS the "outstanding" fact. The table is
 * migration-backed (080), so no existence probe is needed.
 */
async function listOutstandingRevertBatches(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<readonly OutstandingRevertBatch[]> {
  const result = await db.query<{ messageId: string; rewindId: string }>(
    `SELECT rewind_id AS "rewindId", message_id AS "messageId"
       FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
      WHERE thread_id = $1 AND revert_id IS NOT NULL
      ORDER BY rewind_id ASC, message_id ASC`,
    [threadId]
  );
  const byRewindId = new Map<string, string[]>();
  for (const rowItem of result.rows) {
    const ids = byRewindId.get(rowItem.rewindId);
    if (ids) {
      ids.push(rowItem.messageId);
    } else {
      byRewindId.set(rowItem.rewindId, [rowItem.messageId]);
    }
  }
  return [...byRewindId.entries()].map(([rewindId, messageIds]) => ({ messageIds, rewindId }));
}

type OutstandingBatchFloor =
  | { readonly index: number; readonly kind: 'bracket' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unresolvable'; readonly reason: string };

/**
 * The bracket index an outstanding batch's redo needs to survive, derived with
 * the SAME durable resolution `resolveRedoRoots` uses: target message →
 * run range → the bracket anchored on `fromRunId`. `none` = the batch pins no
 * surviving bracket (its target turn's rows are already gone — redo is
 * already `snapshot-missing`, and keeping unrelated history cannot fix it).
 * `unresolvable` = the derivation itself failed; the caller must NOT trim
 * under it (see the module doc comment's OUTSTANDING-REDO FLOOR invariant).
 */
async function resolveOutstandingBatchFloor(
  db: EditCheckpointDatabase,
  threadId: string,
  batch: OutstandingRevertBatch,
  brackets: readonly SnapshotTurnBracket[]
): Promise<OutstandingBatchFloor> {
  const target = await resolveEarliestBatchTarget(db, threadId, batch.messageIds);
  if (!target) {
    return { kind: 'unresolvable', reason: 'its target message could not be resolved' };
  }
  const range = await resolveRewindRunRange(db, target);
  if (range.kind !== 'runs') {
    return {
      kind: 'unresolvable',
      reason: `its run range could not be re-derived (${range.reason})`,
    };
  }
  const bracket = findBracketByRunId(brackets, range.fromRunId);
  if (!bracket) {
    return { kind: 'none' };
  }
  return { index: brackets.indexOf(bracket), kind: 'bracket' };
}

/**
 * Ring trim for one live thread: group its rows into turn brackets and delete
 * every row ordered before the oldest KEPT bracket's first `turn-start` row.
 * Interleaved `pre-revert` rows older than that boundary fall off with it —
 * their redo source predates the retained window by construction. The kept
 * window is FLOORED at the oldest bracket an outstanding tombstone batch still
 * needs for redo (the OUTSTANDING-REDO FLOOR invariant, module doc comment).
 */
async function trimThreadRing(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator,
  threadId: string,
  ring: number
): Promise<void> {
  const rows = await deps.snapshotRepository.snapshotsForThread(threadId);
  const brackets = resolveSnapshotTurnBrackets(rows);
  if (brackets.length <= ring) {
    return;
  }
  let keepFromIndex = brackets.length - ring;
  for (const batch of await listOutstandingRevertBatches(deps.db, threadId)) {
    const floor = await resolveOutstandingBatchFloor(deps.db, threadId, batch, brackets);
    if (floor.kind === 'unresolvable') {
      accumulator.failures.push(
        `ring trim skipped for thread "${threadId}": outstanding rewind batch "${batch.rewindId}" ${floor.reason} — refusing to trim under a pending redo`
      );
      return;
    }
    if (floor.kind === 'bracket') {
      keepFromIndex = Math.min(keepFromIndex, floor.index);
    }
  }
  if (keepFromIndex <= 0) {
    return;
  }
  const boundary = brackets[keepFromIndex];
  if (!boundary) {
    return;
  }
  // The boundary bracket's first row: the first ledger row (ledger order)
  // that is one of its turn-start rows. Everything before it is beyond the
  // ring.
  const boundaryStartRows = new Set([...boundary.startByRoot.values()].map((row) => row.id));
  const boundaryIndex = rows.findIndex((row) => boundaryStartRows.has(row.id));
  if (boundaryIndex <= 0) {
    // A start-less orphan bracket (or already-first boundary) — nothing to trim.
    return;
  }
  const doomed = rows.slice(0, boundaryIndex);
  const deletedRows = await deps.snapshotRepository.deleteByIds(doomed.map((row) => row.id));
  for (const row of doomed) {
    accumulator.touchedRoots.add(row.rootId);
  }
  accumulator.ringTrimmed.push({ deletedRows, threadId });
}

/** Rows grouped `rootId → threadId → oldest surviving non-sentinel oid`. */
async function survivingChainBoundaries(
  db: EditCheckpointDatabase
): Promise<Map<string, Map<string, string>>> {
  const result = await db.query<{ commitOid: string; rootId: string; threadId: string }>(
    `SELECT DISTINCT ON (root_id, thread_id)
            root_id AS "rootId",
            thread_id AS "threadId",
            commit_oid AS "commitOid"
       FROM ${WORKSPACE_SNAPSHOTS_TABLE}
      WHERE commit_oid <> '${FAILED_SNAPSHOT_CAPTURE_OID}'
      ORDER BY root_id, thread_id, created_at ASC, id ASC`
  );
  const byRoot = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    const threads = byRoot.get(row.rootId) ?? new Map<string, string>();
    threads.set(row.threadId, row.commitOid);
    byRoot.set(row.rootId, threads);
  }
  return byRoot;
}

/**
 * Ref-side reconciliation + history reclamation for one live root's shadow
 * repo: delete lineage refs that are dead-thread or row-less residue, then —
 * if this sweep touched the repo at all — shallow-cut at the surviving chain
 * boundaries and `git gc`.
 */
async function reconcileRootRepo(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator,
  historyPrunedRoots: string[],
  root: { readonly path: string; readonly rootId: string },
  accessibleByRootId: ReadonlyMap<string, boolean>,
  liveThreadIds: ReadonlySet<string>,
  boundariesByRoot: ReadonlyMap<string, ReadonlyMap<string, string>>,
  readHostThreads: () => Promise<HostThreads>
): Promise<void> {
  // An unreachable root path (deleted directory, unmounted volume, a stale
  // row like the 2026-08-07 "mock-project" residue) is an EXPECTED condition:
  // skip with visibility and touch nothing — the volume may come back. Only
  // an ACCESSIBLE root whose shadow repo still fails to open is a failure.
  // Probed ONCE per sweep (up front), so both consumers see the same answer.
  if (accessibleByRootId.get(root.rootId) !== true) {
    accumulator.skippedInaccessibleRoots.push({ path: root.path, rootId: root.rootId });
    return;
  }
  let handle: ShadowRepoHandle;
  try {
    handle = await deps.snapshotService.ensureShadowRepo({
      path: root.path,
      rootId: root.rootId,
    });
  } catch (error) {
    accumulator.failures.push(
      `shadow repo unavailable for root "${root.rootId}": ${describeError(error)}`
    );
    return;
  }
  const rootBoundaries = boundariesByRoot.get(root.rootId) ?? new Map<string, string>();
  try {
    const refThreadIds = await deps.snapshotService.listSnapshotThreadIds(handle);
    for (const threadId of refThreadIds) {
      const backedByRows = rootBoundaries.has(threadId);
      if (liveThreadIds.has(threadId) && backedByRows) {
        continue;
      }
      // A host thread's ref lives while the host lists the thread; unread, keep it.
      const hostThreads = await readHostThreads();
      if (hostThreads.kind === 'unavailable' || hostThreads.ids.has(threadId)) {
        continue;
      }
      await deps.snapshotService.pruneThread(handle, threadId);
      accumulator.refOnlyPruned.push({ rootId: root.rootId, threadId });
      accumulator.touchedRoots.add(root.rootId);
    }
  } catch (error) {
    accumulator.failures.push(
      `ref reconciliation failed for root "${root.rootId}": ${describeError(error)}`
    );
  }
  if (!accumulator.touchedRoots.has(root.rootId)) {
    return;
  }
  try {
    await deps.snapshotService.pruneHistory(handle, [...rootBoundaries.values()]);
    historyPrunedRoots.push(root.rootId);
  } catch (error) {
    accumulator.failures.push(
      `history reclamation failed for root "${root.rootId}": ${describeError(error)}`
    );
  }
}

export async function runSnapshotStartupGc(
  deps: SnapshotStartupGcDeps
): Promise<SnapshotStartupGcReport> {
  const ring = deps.turnRing ?? DEFAULT_SNAPSHOT_TURN_RING;
  const accumulator: GcAccumulator = {
    deadThreadsPruned: [],
    failures: [],
    refOnlyPruned: [],
    ringTrimmed: [],
    skippedInaccessibleRoots: [],
    touchedRoots: new Set(),
  };
  const historyPrunedRoots: string[] = [];

  const ledgerThreadIds = await listSnapshotThreadIdsInLedger(deps.db);
  // ORDERING INVARIANT — DO NOT ADD A `mastra_threads` READ BELOW THIS POINT.
  // Everything after `liveThreadIds` classifies and DELETES, and this is the
  // only read of that relation. Its position is what makes an unmigrated
  // database abort with nothing touched (BST-1651 retired the explicit
  // `to_regclass` refusal in favour of this order) — but ONLY together with
  // the short-circuit below: an empty ledger skips the read entirely, and on a
  // genuinely unmigrated database `listSnapshotThreadIdsInLedger` has already
  // raised on `brainstrike_workspace_snapshots` one line up. Order alone is
  // not the whole argument; an empty ledger also has nothing to delete.
  // `snapshot-startup-gc.test.ts` pins the read-before-any-delete ordering
  // directly, so a second reader added after the delete phase fails there.
  const liveThreadIds =
    ledgerThreadIds.length === 0
      ? new Set<string>()
      : await listLiveThreadIds(deps.db, ledgerThreadIds);
  const liveRootsById = new Map(deps.liveRoots.map((root) => [root.rootId, root.path]));
  // Probe every live root's path accessibility ONCE, up front and in
  // parallel — both purgeDeadThread and reconcileRootRepo consume the same
  // answer, so a root cannot flip accessible→inaccessible mid-sweep.
  const probe = deps.isRootPathAccessible ?? isPathAccessible;
  const accessibleByRootId = new Map<string, boolean>(
    await Promise.all(
      deps.liveRoots.map(async (root) => [root.rootId, await probe(root.path)] as const)
    )
  );

  for (const threadId of ledgerThreadIds) {
    try {
      if (liveThreadIds.has(threadId)) {
        await trimThreadRing(deps, accumulator, threadId, ring);
      } else {
        await purgeDeadThread(deps, accumulator, liveRootsById, accessibleByRootId, threadId);
      }
    } catch (error) {
      accumulator.failures.push(
        `snapshot GC failed for thread "${threadId}": ${describeError(error)}`
      );
    }
  }

  // Chain boundaries AFTER trims/purges — they describe what must survive.
  const boundariesByRoot = await survivingChainBoundaries(deps.db);
  const readHostThreads = hostThreadsReader(deps, accumulator);
  for (const root of deps.liveRoots) {
    await reconcileRootRepo(
      deps,
      accumulator,
      historyPrunedRoots,
      root,
      accessibleByRootId,
      liveThreadIds,
      boundariesByRoot,
      readHostThreads
    );
  }

  return {
    deadThreadsPruned: accumulator.deadThreadsPruned,
    failures: accumulator.failures,
    historyPrunedRoots,
    refOnlyPruned: accumulator.refOnlyPruned,
    ringTrimmed: accumulator.ringTrimmed,
    skippedInaccessibleRoots: accumulator.skippedInaccessibleRoots,
  };
}
