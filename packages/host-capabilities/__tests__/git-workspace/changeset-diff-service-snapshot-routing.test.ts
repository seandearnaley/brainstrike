/**
 * Routing pins for the W7 engine swap (BST-1164 T2): `agent-run`/`run-range`
 * resolve through the SNAPSHOT view, the journal fold is unreachable from
 * `ChangesetDiffService`, and a service constructed WITHOUT the snapshot
 * deps reports the typed unavailability error — never a silent journal
 * fallback. `git-scope` routing is untouched (pinned by the existing
 * `changeset-diff-service.integration.test.ts` / `changeset-git-scope.test.ts`).
 */
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import type { StructuredFileDiff } from '@brainstrike/types';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { createHostThreadTurns } from '../../src/git-workspace/changeset-host-turns.ts';
import type {
  ShadowRepoHandle,
  SnapshotService,
} from '../../src/git-workspace/snapshot-service.ts';
import { CHANGESET_VIEW_PATCH_BUDGET_BYTES } from '../../src/git-workspace/structured-diff-content.ts';

const AGENT_RUN = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
const RUN_RANGE = { fromRunId: 'run-1', kind: 'run-range' as const, threadId: 'thread-1' };
const baseDeps = {
  resolveRootCwd: () => Promise.reject(new Error('resolveRootCwd is not under test')),
  run: () => Promise.reject(new Error('git runner is not under test')),
} as const;
function hostTurns(owned = true) {
  // Same committed turn-start shape as the real host Changes integration.
  const row = Schema.decodeSync(HostLogRowSchema, {
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
const ADDED_PATCH =
  'diff --git a/made-by-snapshots.txt b/made-by-snapshots.txt\nnew file mode 100644\n--- /dev/null\n+++ b/made-by-snapshots.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n';
const ADDED: StructuredFileDiff = {
  additions: 2,
  content: { kind: 'full', newContent: 'a\nb\n', oldContent: null, patch: ADDED_PATCH },
  deletions: 0,
  path: 'made-by-snapshots.txt',
  status: 'added',
};

function fakeSnapshotService(diffs: readonly StructuredFileDiff[] = [ADDED]): SnapshotService {
  const notUnderTest = (name: string) => () => {
    throw new Error(`${name} is not under test`);
  };
  return {
    applyRestorePlan: notUnderTest('applyRestorePlan'),
    computeRestorePlan: notUnderTest('computeRestorePlan'),
    diffRefs: () => Promise.resolve([...diffs]),
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
      expect(view.error.code).toBe('changeset.snapshot-engine-unavailable');
    }
    const rangeView = await service.resolveView('root-a', RUN_RANGE);
    expect(rangeView.ok).toBe(false);
    if (!rangeView.ok) {
      expect(rangeView.error.code).toBe('changeset.snapshot-engine-unavailable');
    }
    const diff = await service.fileDiff('root-a', AGENT_RUN, 'x.txt');
    expect(diff.ok).toBe(false);
    if (!diff.ok) {
      expect(diff.error.code).toBe('changeset.snapshot-engine-unavailable');
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
        patch: ADDED_PATCH,
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
  it("carries each file's patch while the view's patches fit their budget, and only then", async () => {
    // Over half the budget each, yet under the per-file bound in characters.
    const count = Math.ceil(CHANGESET_VIEW_PATCH_BUDGET_BYTES / 2 / 180);
    const lines = `+${'€'.repeat(60)}\n`.repeat(count);
    const patchOf = (name: string) =>
      `diff --git a/${name} b/${name}\n@@ -0,0 +1,${count} @@\n${lines}`;
    const bigFile = (name: string): StructuredFileDiff => ({
      additions: count,
      content: { kind: 'full', newContent: 'x\n', oldContent: null, patch: patchOf(name) },
      deletions: 1,
      path: name,
      status: 'added',
    });
    const service = createChangesetDiffService({
      ...baseDeps,
      snapshots: {
        hostThreads: hostTurns().hostThreads,
        resolveService: () => fakeSnapshotService([bigFile('first.txt'), bigFile('second.txt')]),
      },
    });
    const view = await service.resolveView('root-a', AGENT_RUN);
    expect(view.ok).toBe(true);
    if (!view.ok) {
      return;
    }
    const [first, second] = view.value.files;
    expect(first?.patch).toBe(patchOf('first.txt'));
    expect(second?.path).toBe('second.txt');
    expect(second?.patch).toBeNull();
    expect(view.value.totalAdditions).toBe(2 * count);
    expect(view.value.totalDeletions).toBe(2);
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
      expect(view.error.code).toBe('changeset.snapshot-engine-unavailable');
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
      error: expect.objectContaining({ code: 'changeset.snapshot-missing' }),
      ok: false,
    });
    expect(readRows).not.toHaveBeenCalled();
  });
});
