/**
 * Routing pins for the W7 engine swap (BST-1164 T2): `agent-run`/`run-range`
 * resolve through the SNAPSHOT view, the journal fold is unreachable from
 * `ChangesetDiffService`, and a service constructed WITHOUT the snapshot
 * deps reports the typed unavailability error — never a silent journal
 * fallback. `git-scope` routing is untouched (pinned by the existing
 * `changeset-diff-service.integration.test.ts` / `changeset-git-scope.test.ts`).
 */
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createChangesetDiffService } from '../../assistant-server/changeset-diff-service';
import { createHostThreadTurns } from '../../assistant-server/changeset-host-turns';
import type { ShadowRepoHandle, SnapshotService } from '../../assistant-server/snapshot-service';

const AGENT_RUN = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
const RUN_RANGE = { fromRunId: 'run-1', kind: 'run-range' as const, threadId: 'thread-1' };
const baseDeps = {
  resolveRootCwd: () => Promise.reject(new Error('resolveRootCwd is not under test')),
  run: () => Promise.reject(new Error('git runner is not under test')),
} as const;
function hostTurns(owned = true) {
  // Same committed turn-start shape as the real host Changes integration.
  const row = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    event: {
      boundary: 'turn-start',
      roots: [{ commitOid: 'a'.repeat(40), rootId: 'root-a', rootPath: '/ws/a' }],
      runId: 'run-1',
      type: 'workspace.snapshot.recorded',
    },
    seq: 1,
    threadId: 'thread-1',
  });
  const readRows = vi.fn(async () => [row]);
  return {
    hostThreads: createHostThreadTurns({
      listThreads: async () => new Set(owned ? ['thread-1'] : []),
      readRows,
    }),
    readRows,
  };
}
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
  it('WITH snapshot deps, agent-run resolves through the committed host turn', async () => {
    const { hostThreads, readRows } = hostTurns();
    const service = createChangesetDiffService({
      ...baseDeps,
      snapshots: { hostThreads, resolveService: () => fakeSnapshotService() },
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
    expect(readRows).toHaveBeenCalledExactlyOnceWith('thread-1', 0);
  });
  it('a lazily-null SnapshotService (before app-ready) is the typed unavailability error, not a throw', async () => {
    const service = createChangesetDiffService({
      ...baseDeps,
      snapshots: {
        hostThreads: hostTurns().hostThreads,
        resolveService: () => null,
      },
    });
    const view = await service.resolveView('root-a', AGENT_RUN);
    expect(view.ok).toBe(false);
    if (!view.ok) {
      expect(view.error).toMatch(/^snapshot-engine-unavailable:/);
    }
  });
  it('an unknown host thread refuses without attempting a row read or fabricating an empty view', async () => {
    const { hostThreads, readRows } = hostTurns(false);
    const service = createChangesetDiffService({
      ...baseDeps,
      snapshots: { hostThreads, resolveService: () => fakeSnapshotService() },
    });
    const result = await service.resolveView('root-a', AGENT_RUN);
    expect(result).toMatchObject({
      error: expect.stringMatching(/^changeset-snapshot-missing:/),
      ok: false,
    });
    expect(readRows).not.toHaveBeenCalled();
  });
});
