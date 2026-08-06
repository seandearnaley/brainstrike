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
 *  3. RETENTION RING (the plan's GC policy, trigger choice DOCUMENTED here):
 *     keep the newest {@link DEFAULT_SNAPSHOT_TURN_RING} turn brackets per
 *     thread; older ledger rows (including their interleaved `pre-revert`
 *     rows) are deleted. The ring runs in THIS startup sweep, not on
 *     turn-end: the plan pins gc work "idle, never during a run", turn-end
 *     sits between the boundary snapshot and the changeset identity publish
 *     (the BST-1169 hot path), and a boot-time trim bounds growth just as
 *     tightly with zero run-path cost.
 *  4. HISTORY RECLAMATION — after any trim/prune in a repo, the surviving
 *     per-thread chain boundaries (oldest remaining non-sentinel oid per
 *     thread per root) are written as git shallow cut points and
 *     `git gc --prune=now` reclaims everything behind them
 *     (`SnapshotService.pruneHistory` — see its doc for the verified
 *     mechanism).
 *
 * FAILURE POSTURE: never blocks startup (caller runs it fire-and-forget),
 * never throws for a single thread/root — each failure is collected into the
 * report's `failures` and the caller logs them VISIBLY. A missing
 * `mastra_threads` table while snapshot rows exist is a broken invariant:
 * the sweep refuses to classify (it would otherwise treat EVERY thread as
 * dead and mass-delete), reports `threadsTableMissing`, and does nothing —
 * refusing loudly beats guessing on a destructive seam.
 */
import { WORKSPACE_SNAPSHOTS_TABLE } from '@brainstrike/assistant-contract';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { FAILED_SNAPSHOT_CAPTURE_OID, type SnapshotRepository } from './snapshot-repository';
import type { ShadowRepoHandle, SnapshotService } from './snapshot-service';
import { resolveSnapshotTurnBrackets } from './snapshot-turn-ledger';

const THREADS_TABLE = 'mastra_threads';

/** The plan's retention ring: newest 50 turns per thread. */
export const DEFAULT_SNAPSHOT_TURN_RING = 50;

export interface SnapshotStartupGcDeps {
  readonly db: EditCheckpointDatabase;
  /** Connected workspace roots (every `roots` row — disconnect ≠ delete). */
  readonly liveRoots: readonly { readonly path: string; readonly rootId: string }[];
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
  /** True = `mastra_threads` is absent while snapshot rows exist; nothing was
   * touched (see the module doc comment). */
  readonly threadsTableMissing: boolean;
}

interface GcAccumulator {
  readonly deadThreadsPruned: string[];
  readonly failures: string[];
  readonly refOnlyPruned: { rootId: string; threadId: string }[];
  readonly ringTrimmed: { deletedRows: number; threadId: string }[];
  /** Root ids needing a pruneHistory pass. */
  readonly touchedRoots: Set<string>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function threadsTableExists(db: EditCheckpointDatabase): Promise<boolean> {
  const probe = await db.query<{ present: boolean }>(
    `SELECT to_regclass('${THREADS_TABLE}') IS NOT NULL AS present`
  );
  return probe.rows[0]?.present === true;
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
  threadId: string
): Promise<void> {
  const roots = await deps.snapshotRepository.rootsForThread(threadId);
  await deps.snapshotRepository.deleteForThread(threadId);
  for (const root of roots) {
    const livePath = liveRootsById.get(root.rootId);
    if (livePath === undefined) {
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

/**
 * Ring trim for one live thread: group its rows into turn brackets and delete
 * every row ordered before the oldest KEPT bracket's first `turn-start` row.
 * Interleaved `pre-revert` rows older than that boundary fall off with it —
 * their redo source predates the retained window by construction.
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
  const boundary = brackets.at(-ring);
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
  liveThreadIds: ReadonlySet<string>,
  boundariesByRoot: ReadonlyMap<string, ReadonlyMap<string, string>>
): Promise<void> {
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
    touchedRoots: new Set(),
  };
  const historyPrunedRoots: string[] = [];

  const ledgerThreadIds = await listSnapshotThreadIdsInLedger(deps.db);
  const threadsPresent = await threadsTableExists(deps.db);
  if (!threadsPresent) {
    if (ledgerThreadIds.length === 0) {
      // Fresh profile: nothing to classify, nothing to do.
      return {
        deadThreadsPruned: [],
        failures: [],
        historyPrunedRoots: [],
        refOnlyPruned: [],
        ringTrimmed: [],
        threadsTableMissing: false,
      };
    }
    return {
      deadThreadsPruned: [],
      failures: [
        `"${THREADS_TABLE}" does not exist but ${ledgerThreadIds.length} thread(s) have snapshot rows — refusing to classify them as dead (nothing was deleted).`,
      ],
      historyPrunedRoots: [],
      refOnlyPruned: [],
      ringTrimmed: [],
      threadsTableMissing: true,
    };
  }

  const liveThreadIds =
    ledgerThreadIds.length === 0
      ? new Set<string>()
      : await listLiveThreadIds(deps.db, ledgerThreadIds);
  const liveRootsById = new Map(deps.liveRoots.map((root) => [root.rootId, root.path]));

  for (const threadId of ledgerThreadIds) {
    try {
      if (liveThreadIds.has(threadId)) {
        await trimThreadRing(deps, accumulator, threadId, ring);
      } else {
        await purgeDeadThread(deps, accumulator, liveRootsById, threadId);
      }
    } catch (error) {
      accumulator.failures.push(
        `snapshot GC failed for thread "${threadId}": ${describeError(error)}`
      );
    }
  }

  // Chain boundaries AFTER trims/purges — they describe what must survive.
  const boundariesByRoot = await survivingChainBoundaries(deps.db);
  for (const root of deps.liveRoots) {
    await reconcileRootRepo(
      deps,
      accumulator,
      historyPrunedRoots,
      root,
      liveThreadIds,
      boundariesByRoot
    );
  }

  return {
    deadThreadsPruned: accumulator.deadThreadsPruned,
    failures: accumulator.failures,
    historyPrunedRoots,
    refOnlyPruned: accumulator.refOnlyPruned,
    ringTrimmed: accumulator.ringTrimmed,
    threadsTableMissing: false,
  };
}
