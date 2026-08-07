/**
 * Startup snapshot GC (BST-1164 T4) — unit coverage over injected seams:
 * dead-thread purge, ref-only residue pruning, the 50-turn retention ring's
 * boundary math, the missing-threads-table refusal, and per-item failure
 * visibility. Real-git behavior of the primitives it calls lives in
 * `snapshot-service-gc.integration.test.ts`; real-DB row behavior in the
 * repository/journal integration suites.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import {
  FAILED_SNAPSHOT_CAPTURE_OID,
  type SnapshotRepository,
  type WorkspaceSnapshotRow,
} from '../../assistant-server/snapshot-repository';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import {
  runSnapshotStartupGc,
  type SnapshotStartupGcDeps,
} from '../../assistant-server/snapshot-startup-gc';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

interface FixtureOptions {
  /** True ⇒ the outstanding batch's target message resolves to NOTHING (the
   * trim-floor derivation fails) — the fail-safe refusal fixture. */
  readonly batchTargetMissing?: boolean;
  /** rootId → threadId → oldest surviving oid, served to the boundary query. */
  readonly boundaries?: readonly {
    readonly commitOid: string;
    readonly rootId: string;
    readonly threadId: string;
  }[];
  /** thread ids present in the (fake) mastra_threads table. */
  readonly liveThreads?: readonly string[];
  /** One outstanding (unfinalized) revert-bearing tombstone batch, served to
   * the ring trim's floor queries: it targets `targetRunId`'s bracket. Cleared
   * via the returned `finalizeBatch()` to simulate finalization. */
  readonly outstandingBatch?: {
    readonly messageId: string;
    readonly rewindId: string;
    readonly targetRunId: string;
  };
  /** Per-repo refs (rootId → thread ids). */
  readonly refsByRoot?: Readonly<Record<string, readonly string[]>>;
  /** Rows per thread, ledger order. */
  readonly rowsByThread?: Readonly<Record<string, readonly WorkspaceSnapshotRow[]>>;
  readonly threadsTablePresent?: boolean;
}

function row(overrides: Partial<WorkspaceSnapshotRow> & { id: string }): WorkspaceSnapshotRow {
  return {
    commitOid: OID_A,
    createdAt: '2026-08-01 00:00:00.000000+00',
    kind: 'turn-start',
    rootId: 'root-1',
    rootPath: '/tmp/root-1',
    runId: 'run-1',
    threadId: 'thread-1',
    ...overrides,
  };
}

function makeFixture(options: FixtureOptions) {
  const rowsByThread = new Map<string, WorkspaceSnapshotRow[]>(
    Object.entries(options.rowsByThread ?? {}).map(([threadId, rows]) => [threadId, [...rows]])
  );
  const deletedByIds: string[][] = [];
  const deletedThreads: string[] = [];
  const prunedThreads: { rootId: string; threadId: string }[] = [];
  const prunedHistories: { boundaries: readonly string[]; rootId: string }[] = [];

  const outstanding = { current: options.outstandingBatch ?? null };

  const db: EditCheckpointDatabase = {
    query: async <T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: options.threadsTablePresent !== false } as T] };
      }
      // BST-1163: `resolveRewindRunRange` probes the runs table for
      // `turn_message_id` before choosing its query shape. This fixture has
      // no linked rows, so answer "absent" and keep the GC's retention floor
      // on the pre-link `completed_at` query the cases below fake.
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ present: false } as T] };
      }
      if (sql.includes('SELECT DISTINCT thread_id')) {
        return { rows: [...rowsByThread.keys()].map((threadId) => ({ threadId }) as T) };
      }
      if (sql.includes('FROM mastra_threads')) {
        const candidates = (params?.[0] as readonly string[]) ?? [];
        const live = new Set(options.liveThreads ?? []);
        return { rows: candidates.filter((id) => live.has(id)).map((id) => ({ id }) as T) };
      }
      if (sql.includes('SELECT DISTINCT ON (root_id, thread_id)')) {
        return { rows: (options.boundaries ?? []) as unknown as T[] };
      }
      // Trim-floor queries (outstanding tombstone batch → target bracket).
      if (sql.includes('FROM brainstrike_assistant_message_tombstones')) {
        const batch = outstanding.current;
        return {
          rows: batch ? [{ messageId: batch.messageId, rewindId: batch.rewindId } as T] : [],
        };
      }
      if (sql.includes('FROM mastra_messages')) {
        const batch = outstanding.current;
        if (!batch || options.batchTargetMissing === true) {
          return { rows: [] };
        }
        if (sql.includes('WHERE id = $1 AND thread_id = $2')) {
          return {
            rows: [{ createdAt: '2026-08-01 00:00:00.000000+00', id: batch.messageId } as T],
          };
        }
        return { rows: [{ id: batch.messageId } as T] };
      }
      if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
        const batch = outstanding.current;
        return { rows: batch ? [{ id: batch.targetRunId } as T] : [] };
      }
      throw new Error(`unexpected GC query: ${sql}`);
    },
  };

  const repository = {
    deleteByIds: vi.fn(async (ids: readonly string[]) => {
      deletedByIds.push([...ids]);
      return ids.length;
    }),
    deleteForThread: vi.fn(async (threadId: string) => {
      deletedThreads.push(threadId);
      const rows = rowsByThread.get(threadId) ?? [];
      rowsByThread.delete(threadId);
      const roots = new Map<string, string[]>();
      for (const item of rows) {
        roots.set(item.rootId, [...(roots.get(item.rootId) ?? []), item.commitOid]);
      }
      return [...roots.entries()].map(([rootId, commitOids]) => ({ commitOids, rootId }));
    }),
    insertSnapshot: vi.fn(),
    latestSnapshotFor: vi.fn(),
    rootsForThread: vi.fn(async (threadId: string) => {
      const seen = new Map<string, string>();
      for (const item of rowsByThread.get(threadId) ?? []) {
        seen.set(item.rootId, item.rootPath);
      }
      return [...seen.entries()].map(([rootId, rootPath]) => ({ rootId, rootPath }));
    }),
    snapshotsForThread: vi.fn(async (threadId: string) => rowsByThread.get(threadId) ?? []),
  } as unknown as SnapshotRepository;

  const service = {
    ensureShadowRepo: vi.fn(async (root: { path: string; rootId: string }) => ({
      gitDir: `/shadow/${root.rootId}/git`,
      rootId: root.rootId,
      rootPath: root.path,
    })),
    listSnapshotThreadIds: vi.fn(async (handle: { rootId: string }) => [
      ...(options.refsByRoot?.[handle.rootId] ?? []),
    ]),
    pruneHistory: vi.fn(
      async (handle: { rootId: string }, boundaries: readonly string[]): Promise<void> => {
        prunedHistories.push({ boundaries, rootId: handle.rootId });
      }
    ),
    pruneThread: vi.fn(async (handle: { rootId: string }, threadId: string) => {
      prunedThreads.push({ rootId: handle.rootId, threadId });
      return { deleted: true };
    }),
  } as unknown as SnapshotService;

  const deps: SnapshotStartupGcDeps = {
    db,
    liveRoots: [{ path: '/tmp/root-1', rootId: 'root-1' }],
    snapshotRepository: repository,
    snapshotService: service,
    turnRing: 2,
  };
  return {
    deletedByIds,
    deletedThreads,
    deps,
    finalizeBatch: () => {
      outstanding.current = null;
    },
    prunedHistories,
    prunedThreads,
    service,
  };
}

/** N alternating turn-start/turn-end bracket rows for one thread. */
function turnRows(threadId: string, turns: number): WorkspaceSnapshotRow[] {
  const rows: WorkspaceSnapshotRow[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const stamp = `2026-08-01 00:${String(turn).padStart(2, '0')}:00.000000+00`;
    rows.push(
      row({
        createdAt: stamp,
        id: `${threadId}-t${turn}-start`,
        kind: 'turn-start',
        runId: `${threadId}-run-${turn}`,
        threadId,
      }),
      row({
        createdAt: stamp,
        id: `${threadId}-t${turn}-end`,
        kind: 'turn-end',
        runId: `${threadId}-run-${turn}`,
        threadId,
      })
    );
  }
  return rows;
}

describe('runSnapshotStartupGc', () => {
  it('refuses to classify when mastra_threads is missing but rows exist — nothing deleted, visibly reported', async () => {
    const fixture = makeFixture({
      rowsByThread: { 'thread-1': turnRows('thread-1', 1) },
      threadsTablePresent: false,
    });
    const report = await runSnapshotStartupGc(fixture.deps);
    expect(report.threadsTableMissing).toBe(true);
    expect(report.failures).toHaveLength(1);
    expect(fixture.deletedThreads).toEqual([]);
    expect(fixture.deletedByIds).toEqual([]);
    expect(fixture.prunedThreads).toEqual([]);
  });

  it('is a quiet no-op on a fresh profile (no rows, no threads table)', async () => {
    const fixture = makeFixture({ threadsTablePresent: false });
    const report = await runSnapshotStartupGc(fixture.deps);
    expect(report).toMatchObject({ failures: [], threadsTableMissing: false });
  });

  it('purges a dead thread: rows deleted, per-live-root ref pruned, repo history reclaimed', async () => {
    const fixture = makeFixture({
      boundaries: [],
      liveThreads: [],
      refsByRoot: { 'root-1': [] },
      rowsByThread: { 'thread-dead': turnRows('thread-dead', 1) },
    });
    const report = await runSnapshotStartupGc(fixture.deps);
    expect(report.deadThreadsPruned).toEqual(['thread-dead']);
    expect(fixture.deletedThreads).toEqual(['thread-dead']);
    expect(fixture.prunedThreads).toEqual([{ rootId: 'root-1', threadId: 'thread-dead' }]);
    // The touched repo gets a pruneHistory pass with the (now empty) boundary set.
    expect(fixture.prunedHistories).toEqual([{ boundaries: [], rootId: 'root-1' }]);
  });

  it('trims a live thread to the newest ring turns, including interleaved pre-revert rows', async () => {
    const rows = turnRows('thread-1', 4);
    // A pre-revert row between turn 0 and turn 1 — beyond the ring, must fall off.
    rows.splice(
      2,
      0,
      row({
        createdAt: '2026-08-01 00:00:30.000000+00',
        id: 'thread-1-prerevert-old',
        kind: 'pre-revert',
        runId: 'revert-1',
        threadId: 'thread-1',
      })
    );
    const fixture = makeFixture({
      boundaries: [{ commitOid: OID_C, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      refsByRoot: { 'root-1': ['thread-1'] },
      rowsByThread: { 'thread-1': rows },
    });
    const report = await runSnapshotStartupGc(fixture.deps);
    // Ring = 2 keeps turns 2 & 3; turns 0/1 (+ the old pre-revert) fall off.
    expect(fixture.deletedByIds).toEqual([
      [
        'thread-1-t0-start',
        'thread-1-t0-end',
        'thread-1-prerevert-old',
        'thread-1-t1-start',
        'thread-1-t1-end',
      ],
    ]);
    expect(report.ringTrimmed).toEqual([{ deletedRows: 5, threadId: 'thread-1' }]);
    // The trimmed repo is shallow-cut at the surviving boundary and gc'd.
    expect(fixture.prunedHistories).toEqual([{ boundaries: [OID_C], rootId: 'root-1' }]);
    // The live, row-backed ref stays.
    expect(fixture.prunedThreads).toEqual([]);
  });

  it('floors the ring trim at an outstanding batch’s target bracket, then reclaims after finalization', async () => {
    const rows = turnRows('thread-1', 4);
    // The outstanding rewind's redo source: a pre-revert row at the tail.
    rows.push(
      row({
        createdAt: '2026-08-01 00:04:00.000000+00',
        id: 'thread-1-prerevert-live',
        kind: 'pre-revert',
        runId: 'revert-live',
        threadId: 'thread-1',
      })
    );
    const fixture = makeFixture({
      boundaries: [{ commitOid: OID_A, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      // The batch targets turn 0 — OLDER than the ring (ring = 2 keeps 2 & 3).
      outstandingBatch: {
        messageId: 'msg-old',
        rewindId: 'rw-outstanding',
        targetRunId: 'thread-1-run-0',
      },
      refsByRoot: { 'root-1': ['thread-1'] },
      rowsByThread: { 'thread-1': rows },
    });

    const floored = await runSnapshotStartupGc(fixture.deps);
    // The floor wins over the ring: turn 0 (and everything after it) survives,
    // so redo's turn-start baseline and its pre-revert source both stay.
    expect(fixture.deletedByIds).toEqual([]);
    expect(floored.ringTrimmed).toEqual([]);
    expect(floored.failures).toEqual([]);
    // The live, row-backed lineage ref stays too.
    expect(fixture.prunedThreads).toEqual([]);

    // Finalization deletes the batch's tombstone rows → the floor disappears
    // and the NEXT sweep reclaims the beyond-ring turns.
    fixture.finalizeBatch();
    const reclaimed = await runSnapshotStartupGc(fixture.deps);
    expect(fixture.deletedByIds).toEqual([
      ['thread-1-t0-start', 'thread-1-t0-end', 'thread-1-t1-start', 'thread-1-t1-end'],
    ]);
    expect(reclaimed.ringTrimmed).toEqual([{ deletedRows: 4, threadId: 'thread-1' }]);
  });

  it('refuses to trim (visible failure) when an outstanding batch’s target cannot be re-derived', async () => {
    const fixture = makeFixture({
      batchTargetMissing: true,
      boundaries: [{ commitOid: OID_A, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      outstandingBatch: {
        messageId: 'msg-gone',
        rewindId: 'rw-unresolvable',
        targetRunId: 'thread-1-run-0',
      },
      refsByRoot: { 'root-1': ['thread-1'] },
      rowsByThread: { 'thread-1': turnRows('thread-1', 4) },
    });

    const report = await runSnapshotStartupGc(fixture.deps);

    // Fail-safe on a destructive seam: nothing trimmed, the refusal is named.
    expect(fixture.deletedByIds).toEqual([]);
    expect(report.ringTrimmed).toEqual([]);
    expect(report.failures.join('\n')).toContain('rw-unresolvable');
    expect(report.failures.join('\n')).toContain('refusing to trim under a pending redo');
  });

  it('leaves a thread within the ring untouched (and skips pruneHistory for untouched repos)', async () => {
    const fixture = makeFixture({
      boundaries: [{ commitOid: OID_A, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      refsByRoot: { 'root-1': ['thread-1'] },
      rowsByThread: { 'thread-1': turnRows('thread-1', 2) },
    });
    const report = await runSnapshotStartupGc(fixture.deps);
    expect(fixture.deletedByIds).toEqual([]);
    expect(report.ringTrimmed).toEqual([]);
    expect(fixture.prunedHistories).toEqual([]);
  });

  it('prunes a surviving ref with NO rows behind it (ref-only residue)', async () => {
    const fixture = makeFixture({
      boundaries: [{ commitOid: OID_B, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      refsByRoot: { 'root-1': ['thread-1', 'thread-ghost'] },
      rowsByThread: { 'thread-1': turnRows('thread-1', 1) },
    });
    const report = await runSnapshotStartupGc(fixture.deps);
    expect(report.refOnlyPruned).toEqual([{ rootId: 'root-1', threadId: 'thread-ghost' }]);
    expect(fixture.prunedThreads).toEqual([{ rootId: 'root-1', threadId: 'thread-ghost' }]);
    expect(fixture.prunedHistories).toEqual([{ boundaries: [OID_B], rootId: 'root-1' }]);
  });

  it('collects per-item failures without aborting the sweep (visible, non-fatal)', async () => {
    const fixture = makeFixture({
      boundaries: [],
      liveThreads: [],
      refsByRoot: { 'root-1': [] },
      rowsByThread: { 'thread-dead': turnRows('thread-dead', 1) },
    });
    (
      fixture.service.ensureShadowRepo as unknown as { mockRejectedValue: (e: Error) => void }
    ).mockRejectedValue(new Error('root vanished'));
    const report = await runSnapshotStartupGc(fixture.deps);
    // Rows still purge; the ref prune + repo reconciliation failures are named.
    expect(fixture.deletedThreads).toEqual(['thread-dead']);
    expect(report.deadThreadsPruned).toEqual(['thread-dead']);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.join('\n')).toContain('root vanished');
  });

  it('never treats a failed-capture sentinel as a chain boundary (query excludes it by construction)', async () => {
    // The boundary query is pinned by SQL shape here: the fake returns what
    // production SQL would, and the sweep forwards it verbatim.
    const fixture = makeFixture({
      boundaries: [{ commitOid: OID_A, rootId: 'root-1', threadId: 'thread-1' }],
      liveThreads: ['thread-1'],
      refsByRoot: { 'root-1': ['thread-1', 'thread-ghost'] },
      rowsByThread: { 'thread-1': turnRows('thread-1', 1) },
    });
    await runSnapshotStartupGc(fixture.deps);
    const boundaries = fixture.prunedHistories[0]?.boundaries ?? [];
    expect(boundaries).not.toContain(FAILED_SNAPSHOT_CAPTURE_OID);
  });
});
