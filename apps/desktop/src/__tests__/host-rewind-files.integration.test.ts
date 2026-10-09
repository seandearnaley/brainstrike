// @vitest-environment node
/**
 * Real-git coverage for a host thread's rewind restores in Main (BST-1977,
 * gap 2): the legacy rewind engine's rules over the shared shadow-git owner,
 * with the host log as the record (no ledger row).
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHostRewindFiles } from '../agent-host-platform/host-rewind-files';
import type { CheckpointReindexAction } from '../assistant-server/checkpoint-reindex-deps';
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
let reindexed: CheckpointReindexAction[] = [];

function owner(mounted = true) {
  return createHostRewindFiles({
    reindex: async () => async (action) => {
      reindexed.push(action);
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
  // The legacy post-restore reindex: a restored path re-indexes, a deleted one invalidates.
  expect(reindexed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: 'v1\n',
        kind: 'restore',
        rootId: ROOT_ID,
        workspacePath: 'notes.txt',
      }),
      { kind: 'delete', rootId: ROOT_ID, workspacePath: 'made.txt' },
      { kind: 'delete', rootId: ROOT_ID, workspacePath: 'late.txt' },
    ])
  );
  expect(reindexed).toHaveLength(3);
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
  // Redo reindexes the paths it brings back.
  expect(reindexed.map(({ kind, workspacePath }) => `${kind} ${workspacePath}`).sort()).toEqual([
    'restore late.txt',
    'restore made.txt',
    'restore notes.txt',
  ]);
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
