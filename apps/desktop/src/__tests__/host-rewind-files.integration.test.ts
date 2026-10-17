// @vitest-environment node
/**
 * Real-git coverage for a host thread's rewind restores in Main (BST-1977,
 * gap 2): the legacy rewind engine's rules over the shared shadow-git owner,
 * with the host log as the record (no ledger row).
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostLogRow, HostTurnSnapshot } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHostRewindFiles } from '../agent-host-platform/host-rewind-files';
import { execFileSnapshotGitRunner } from '../assistant-server/snapshot-git';
import { createSnapshotService, type SnapshotService } from '../assistant-server/snapshot-service';

const THREAD = 'host-rewind-thread';
const ROOT_ID = 'root-1';
const HEAVY_TIMEOUT_MS = 60_000;
let root: string;
let shadow: string;
let service: SnapshotService;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bs-host-rewind-root-')));
  shadow = await realpath(await mkdtemp(join(tmpdir(), 'bs-host-rewind-shadow-')));
  service = createSnapshotService({ runner: execFileSnapshotGitRunner, snapshotsBaseDir: shadow });
  reindexed = [];
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(shadow, { force: true, recursive: true });
});
const read = (name: string) => readFile(join(root, name), 'utf8').catch(() => null);
/** Every reindex action the restores feed, in order. */
let reindexed: string[] = [];
function owner(mounted = true) {
  return createHostRewindFiles({
    refreshWorkspaceIndex: async (rootId) => {
      reindexed.push(rootId);
    },
    resolveWorkspaceRoot: async (rootId) => {
      if (!(mounted && rootId === ROOT_ID)) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root;
    },
    snapshots: () => service,
  });
}
/** The target turn: notes at v1; then the run rewrites notes and creates a file. */
async function turn() {
  await writeFile(join(root, 'notes.txt'), 'v1\n');
  const handle = await service.ensureShadowRepo({ path: root, rootId: ROOT_ID });
  const { commitOid } = await service.snapshot(handle, {
    kind: 'turn-start',
    runId: 'run-1',
    threadId: THREAD,
  });
  await writeFile(join(root, 'notes.txt'), 'v2\n');
  await writeFile(join(root, 'made.txt'), 'made by the run\n');
  return [{ commitOid, rootId: ROOT_ID, rootPath: root }];
}
test('a rewind restores the turn, refuses drift until acknowledged, and redo undoes it from its pre-revert snapshot alone', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  const targets = await turn();
  const files = owner();
  const { previewId } = await files.preview({ targets, threadId: THREAD });
  expect(await files.drift({ previewId, threadId: THREAD })).toEqual([]);
  await writeFile(join(root, 'late.txt'), 'written after the preview\n');
  expect(await files.drift({ previewId, threadId: THREAD })).toEqual([
    { path: 'late.txt', rootId: ROOT_ID },
  ]);
  const outcomes = await files.apply({
    previewId,
    rewindId: 'rewind-1',
    targets,
    threadId: THREAD,
  });
  expect(outcomes).toEqual(
    expect.arrayContaining([
      { path: 'notes.txt', rootId: ROOT_ID, status: 'restored' },
      { path: 'made.txt', rootId: ROOT_ID, status: 'deleted' },
      { path: 'late.txt', rootId: ROOT_ID, status: 'deleted' },
    ])
  );
  expect(await read('notes.txt')).toBe('v1\n');
  expect(await read('made.txt')).toBeNull();
  // One native root scan reconciles every restored and deleted file.
  expect(reindexed).toEqual([ROOT_ID]);
  reindexed = [];
  // A preview binds one apply.
  await expect(files.drift({ previewId, threadId: THREAD })).rejects.toThrow('preview-required');
  // A fresh owner (a restart) finds the pre-revert snapshot by the rewind's ID alone.
  const restarted = owner();
  expect(
    await restarted.redoConflicts({ rewindId: 'rewind-1', targets, threadId: THREAD })
  ).toEqual([]);
  await restarted.redo({ acknowledged: [], rewindId: 'rewind-1', targets, threadId: THREAD });
  expect(await read('notes.txt')).toBe('v2\n');
  expect(await read('made.txt')).toBe('made by the run\n');
  expect(await read('late.txt')).toBe('written after the preview\n');
  expect(reindexed).toEqual([ROOT_ID]);
});
test('a redo names paths changed after the rewind, and forces only those acknowledged', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  const targets = await turn();
  const files = owner();
  const { previewId } = await files.preview({ targets, threadId: THREAD });
  await files.apply({ previewId, rewindId: 'rewind-1', targets, threadId: THREAD });
  await writeFile(join(root, 'notes.txt'), 'edited after the rewind\n');
  const request = { rewindId: 'rewind-1', targets, threadId: THREAD };
  const conflicts = await files.redoConflicts(request);
  expect(conflicts).toEqual([{ path: 'notes.txt', rootId: ROOT_ID }]);
  // Unacknowledged, the edited path is left untouched; the rest is redone.
  const unforced = await files.redo({ ...request, acknowledged: [] });
  expect(unforced).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'notes.txt', status: 'conflict' })])
  );
  expect(await read('notes.txt')).toBe('edited after the rewind\n');
  expect(await read('made.txt')).toBe('made by the run\n');
  await files.redo({ ...request, acknowledged: conflicts });
  expect(await read('notes.txt')).toBe('v2\n');
});
test('an unmounted root, an unknown preview, or a missing pre-revert snapshot refuses visibly', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  const targets = await turn();
  await expect(owner(false).preview({ targets, threadId: THREAD })).rejects.toThrow(
    'no longer mounted'
  );
  await expect(owner().drift({ previewId: 'never-shown', threadId: THREAD })).rejects.toThrow(
    'preview-required'
  );
  await expect(
    owner().redoConflicts({ rewindId: 'never-applied', targets, threadId: THREAD })
  ).rejects.toThrow('snapshot-missing');
  expect(await read('notes.txt')).toBe('v2\n');
});
test('startup GC preserves an outstanding host redo target older than the retention ring', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  const { HostLogRowSchema } = await import('@brainstrike/agent-host/protocol');
  const { listThreadSnapshotChain } = await import('../assistant-server/snapshot-chains');
  const { runSnapshotStartupGc } = await import('../assistant-server/snapshot-startup-gc');
  const handle = await service.ensureShadowRepo({ path: root, rootId: ROOT_ID });
  const rows: HostLogRow[] = [];
  const targets: HostTurnSnapshot[] = [];
  for (let turnIndex = 1; turnIndex <= 4; turnIndex += 1) {
    await writeFile(join(root, 'notes.txt'), `v${turnIndex}\n`);
    const snapshot = await service.snapshot(handle, {
      kind: 'turn-start',
      runId: `run-${turnIndex}`,
      threadId: THREAD,
    });
    const capture = { commitOid: snapshot.commitOid, rootId: ROOT_ID, rootPath: root };
    if (turnIndex === 1) {
      targets.push(capture);
    }
    rows.push(
      Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
        event: {
          boundary: 'turn-start',
          roots: [capture],
          runId: `run-${turnIndex}`,
          type: 'workspace.snapshot.recorded',
        },
        seq: rows.length + 1,
        threadId: THREAD,
      })
    );
  }
  const files = owner();
  const { previewId } = await files.preview({ targets, threadId: THREAD });
  const rewindId = 'pending-old-turn';
  rows.push(
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
      event: {
        commandId: 'rewind-command',
        headId: null,
        messageId: 'message-1',
        mode: 'conversation-and-files',
        rewindId,
        runId: 'run-1',
        type: 'thread.rewind.started',
      },
      seq: rows.length + 1,
      threadId: THREAD,
    })
  );
  await files.apply({ previewId, rewindId, targets, threadId: THREAD });
  const dependencies = {
    liveRoots: [{ path: root, rootId: ROOT_ID }],
    readHostThreadIds: async () => new Set([THREAD]),
    readHostThreadRows: async () => rows,
    readThreadChain: (repo: typeof handle, threadId: string) =>
      listThreadSnapshotChain(execFileSnapshotGitRunner, repo, threadId),
    snapshotService: service,
    turnRing: 2,
  };
  const report = await runSnapshotStartupGc(dependencies);
  expect(report.failures).toEqual([]);
  expect(await owner().redoConflicts({ rewindId, targets, threadId: THREAD })).toEqual([]);
  await owner().redo({ acknowledged: [], rewindId, targets, threadId: THREAD });
  expect(await read('notes.txt')).toBe('v4\n');
});
