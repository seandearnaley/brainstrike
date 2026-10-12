/**
 * Routing pins for the W7 engine swap (BST-1164 T2): `agent-run`/`run-range`
 * resolve through the SNAPSHOT view, the journal fold is unreachable from
 * `ChangesetDiffService`, and a service constructed WITHOUT the snapshot
 * deps reports the typed unavailability error — never a silent journal
 * fallback. `git-scope` routing is untouched (pinned by the existing
 * `changeset-diff-service.integration.test.ts` / `changeset-git-scope.test.ts`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChangesetDiffService } from '../../assistant-server/changeset-diff-service';
import type { MainQueryHandle } from '../../assistant-server/main-query-handle';
import type {
  InsertWorkspaceSnapshotInput,
  SnapshotRepository,
  WorkspaceSnapshotRow,
} from '../../assistant-server/snapshot-repository';
import type { ShadowRepoHandle, SnapshotService } from '../../assistant-server/snapshot-service';
import { createSnapshotTurnRegistry } from '../../assistant-server/snapshot-turn-registry';

const AGENT_RUN = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
const RUN_RANGE = { fromRunId: 'run-1', kind: 'run-range' as const, threadId: 'thread-1' };

const dummyDb: MainQueryHandle = {
  query: () => {
    throw new Error('no database in this test');
  },
};

const baseDeps = {
  resolveDatabase: () => Promise.resolve(dummyDb),
  resolveRootCwd: () => Promise.reject(new Error('resolveRootCwd is not under test')),
  run: () => Promise.reject(new Error('git runner is not under test')),
} as const;

function fakeSnapshotService(): SnapshotService {
  const notUnderTest = (name: string) => () => {
    throw new Error(`${name} is not under test`);
  };
  return {
    applyRestorePlan: notUnderTest('applyRestorePlan'),
    computeRestorePlan: notUnderTest('computeRestorePlan'),
    diffRefs: () =>
      Promise.resolve([
        {
          additions: 2,
          content: { kind: 'full', newContent: 'a\nb\n', oldContent: null },
          deletions: 0,
          hunks: [],
          path: 'made-by-snapshots.txt',
          status: 'added' as const,
        },
      ]),
    ensureShadowRepo: (root: { readonly path: string; readonly rootId: string }) =>
      Promise.resolve(
        Object.freeze({
          gitDir: `/shadow/${root.rootId}/git`,
          rootId: root.rootId,
          rootPath: root.path,
        }) as ShadowRepoHandle
      ),
    pruneThread: notUnderTest('pruneThread'),
    snapshot: notUnderTest('snapshot'),
    snapshotFileHashes: notUnderTest('snapshotFileHashes'),
    sweepOrphans: notUnderTest('sweepOrphans'),
  } as unknown as SnapshotService;
}

function fakeRepository(): SnapshotRepository {
  const rows: WorkspaceSnapshotRow[] = [];
  return {
    deleteByIds: () => Promise.resolve(0),
    deleteForThread: () => Promise.resolve([]),
    insertSnapshot: (input: InsertWorkspaceSnapshotInput) => {
      const row: WorkspaceSnapshotRow = {
        commitOid: input.commitOid,
        createdAt: String(rows.length + 1).padStart(8, '0'),
        id: `row-${rows.length + 1}`,
        kind: input.kind,
        rootId: input.rootId,
        rootPath: input.rootPath,
        runId: input.runId ?? null,
        threadId: input.threadId,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    latestSnapshotFor: () => Promise.resolve(null),
    rootsForThread: () => Promise.resolve([]),
    snapshotsForThread: () => Promise.resolve(rows),
  };
}

describe('ChangesetDiffService — W7 snapshot routing', () => {
  it('WITHOUT snapshot deps, agent-run and run-range resolve to the typed snapshot-engine-unavailable error (no journal fallback)', async () => {
    const service = createChangesetDiffService({ ...baseDeps });

    const view = await service.resolveView('root-a', AGENT_RUN);
    expect(view.ok).toBe(false);
    if (!view.ok) {
      expect(view.error).toMatch(/^snapshot-engine-unavailable:/);
    }
    const rangeView = await service.resolveView('root-a', RUN_RANGE);
    expect(rangeView.ok).toBe(false);
    if (!rangeView.ok) {
      expect(rangeView.error).toMatch(/^snapshot-engine-unavailable:/);
    }
    const diff = await service.fileDiff('root-a', AGENT_RUN, 'x.txt');
    expect(diff.ok).toBe(false);
    if (!diff.ok) {
      expect(diff.error).toMatch(/^snapshot-engine-unavailable:/);
    }
  });

  it('WITH snapshot deps, agent-run resolves through the snapshot view (live registry turn, zero DB reads)', async () => {
    const registry = createSnapshotTurnRegistry();
    registry.beginTurn('thread-1', {
      anchorMessageId: 'msg-1',
      runId: 'run-1',
      startOutcomes: new Map([
        ['root-a', { commitOid: 'a'.repeat(40), kind: 'captured' as const, rootPath: '/ws/a' }],
      ]),
    });
    let dbReads = 0;
    const service = createChangesetDiffService({
      ...baseDeps,
      resolveDatabase: () => {
        dbReads += 1;
        return Promise.resolve(dummyDb);
      },
      snapshots: {
        createRepository: () => fakeRepository(),
        registry,
        resolveService: () => fakeSnapshotService(),
      },
    });

    const view = await service.resolveView('root-a', AGENT_RUN);
    expect(view.ok).toBe(true);
    if (!view.ok) {
      return;
    }
    expect(view.value.files).toEqual([
      expect.objectContaining({
        additions: 2,
        path: 'made-by-snapshots.txt',
        rootId: 'root-a',
        status: 'added',
      }),
    ]);
    // REAL totals from the snapshot diffs, never the journal's null.
    expect(view.value.totalAdditions).toBe(2);
    expect(view.value.totalDeletions).toBe(0);
    // The LIVE path performed zero database resolutions.
    expect(dbReads).toBe(0);
  });

  it('a lazily-null SnapshotService (before app-ready) is the typed unavailability error, not a throw', async () => {
    const service = createChangesetDiffService({
      ...baseDeps,
      snapshots: {
        createRepository: () => fakeRepository(),
        registry: createSnapshotTurnRegistry(),
        resolveService: () => null,
      },
    });
    const view = await service.resolveView('root-a', AGENT_RUN);
    expect(view.ok).toBe(false);
    if (!view.ok) {
      expect(view.error).toMatch(/^snapshot-engine-unavailable:/);
    }
  });

  it('the journal fold module is not imported by the dispatch at all (source pin — T4 deletes the module)', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../assistant-server/changeset-diff-service.ts'),
      'utf8'
    );
    expect(source.includes("from './changeset-journal-view'")).toBe(false);
    expect(source.includes("from './changeset-snapshot-view'")).toBe(true);
  });
});
