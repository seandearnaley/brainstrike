/**
 * A settled turn's view reverts whole files back to the turn's start, only
 * while each is exactly as the turn left it (Sean's call, 2026-11-05). Real
 * snapshots of a real folder; the host log is the rows a host run commits.
 */
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChangesActionTarget, ChangesetView } from '@brainstrike/types';
import { Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { createHostThreadTurns } from '../../src/git-workspace/changeset-host-turns.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { execFileSnapshotGitRunner } from '../../src/git-workspace/snapshot-git.ts';
import { createSnapshotService } from '../../src/git-workspace/snapshot-service.ts';

const TURN = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
const decodeRow = Schema.decodeSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' });

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bs-turn-revert-'));
  root = path.join(base, 'root');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'gone.txt'), 'kept until the turn\n');
  await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'later.txt'), 'before\n');
  root = await realpath(root);
});

afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

const write = (file: string, text: string | Buffer) => writeFile(path.join(root, file), text);
const read = (file: string) => readFile(path.join(root, file), 'utf8');

/** Edit, add, delete and rewrite a binary file. */
async function editAddDeleteRewrite() {
  await write('src/a.txt', 'one\nTWO\nthree\n');
  await write('src/new.txt', 'made by the turn\n');
  await rm(path.join(root, 'gone.txt'));
  await write('image.bin', Buffer.from([0, 9, 9, 9]));
  await write('later.txt', 'during\n');
}

const GUIDE = 'line one\nline two\nline three\nline four\n';

/** Move the guide and edit one line of it. */
async function moveTheGuide() {
  await rename(path.join(root, 'docs/guide.md'), path.join(root, 'docs/manual.md'));
  await write('docs/manual.md', GUIDE.replace('four', '4'));
}

/** A turn of `during` between two real snapshots. */
async function settledTurn(
  options: { during?: () => Promise<void>; mountedAt?: string; running?: boolean } = {}
) {
  const snapshots = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: path.join(base, 'snapshots'),
  });
  const handle = await snapshots.ensureShadowRepo({ path: root, rootId: 'root-a' });
  const start = await snapshots.snapshot(handle, {
    kind: 'turn-start',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  await (options.during ?? editAddDeleteRewrite)();
  const end = await snapshots.snapshot(handle, {
    kind: 'turn-end',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  const recorded = (seq: number, boundary: 'turn-end' | 'turn-start', commitOid: string) =>
    decodeRow({
      event: {
        boundary,
        roots: [{ commitOid, rootId: 'root-a', rootPath: root }],
        runId: 'run-1',
        type: 'workspace.snapshot.recorded',
      },
      seq,
      threadId: 'thread-1',
    });
  const rows = [recorded(1, 'turn-start', start.commitOid), recorded(2, 'turn-end', end.commitOid)];
  const hostThreads = createHostThreadTurns({
    listThreads: async () => [{ running: options.running ?? false, threadId: 'thread-1' }],
    readRows: async (_threadId, fromSeq) => rows.filter((row) => row.seq > fromSeq),
  });
  const service = createChangesetDiffService({
    resolveRootCwd: async (rootId): Promise<BoundaryResult<string>> => ({
      ok: true,
      value: rootId === 'root-a' ? (options.mountedAt ?? root) : '/nowhere',
    }),
    run: execFileGitRunner,
    snapshots: { hostThreads, resolveService: () => snapshots },
  });
  const view = async (): Promise<ChangesetView> => {
    const result = await service.resolveView('root-a', TURN);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };
  const offered = async () =>
    Object.fromEntries((await view()).files.map((file) => [file.path, file.actions]));
  const revert = async (paths: readonly string[], target?: ChangesActionTarget) => {
    const drawn = await view();
    const files = drawn.files
      .filter((file) => paths.includes(file.path))
      .map(({ path: filePath, revision }) => ({ path: filePath, revision }));
    return await service.apply({
      action: 'revert',
      changeset: TURN,
      rootId: 'root-a',
      target: target ?? { files, kind: 'files' },
    });
  };
  return { offered, revert, view };
}

describe('reverting files from a settled turn', () => {
  it('offers each file still as the turn left it, as a whole file', async () => {
    const turn = await settledTurn();
    const files = (await turn.view()).files;
    expect(files.map((file) => file.path).sort()).toEqual([
      'gone.txt',
      'image.bin',
      'later.txt',
      'src/a.txt',
      'src/new.txt',
    ]);
    expect(files.every((file) => file.wholeFile === true)).toBe(true);
    expect(Object.values(await turn.offered())).toEqual(new Array(5).fill(['revert']));

    await write('later.txt', 'after the turn\n');
    await write('gone.txt', 'written again\n');
    expect(await turn.offered()).toEqual({
      'gone.txt': [],
      'image.bin': ['revert'],
      'later.txt': [],
      'src/a.txt': ['revert'],
      'src/new.txt': ['revert'],
    });
  });

  it('puts each file back as it was before the turn, and then offers it no more', async () => {
    const turn = await settledTurn();
    const result = await turn.revert(['gone.txt', 'image.bin', 'src/a.txt', 'src/new.txt']);
    expect(result).toEqual({
      ok: true,
      value: {
        paths: expect.arrayContaining(['gone.txt', 'image.bin', 'src/a.txt', 'src/new.txt']),
      },
    });
    expect(await read('src/a.txt')).toBe('one\ntwo\nthree\n');
    expect(await read('gone.txt')).toBe('kept until the turn\n');
    expect([...(await readFile(path.join(root, 'image.bin')))]).toEqual([0, 1, 2, 3]);
    await expect(read('src/new.txt')).rejects.toThrow('ENOENT');
    expect(await read('later.txt')).toBe('during\n');
    expect(await turn.offered()).toEqual({
      'gone.txt': [],
      'image.bin': [],
      'later.txt': ['revert'],
      'src/a.txt': [],
      'src/new.txt': [],
    });
  });

  it('writes nothing when any file changed since the turn', async () => {
    const turn = await settledTurn();
    const drawn = await turn.view();
    await write('later.txt', 'after the turn\n');
    const files = drawn.files
      .filter((file) => file.path === 'src/a.txt' || file.path === 'later.txt')
      .map(({ path: filePath, revision }) => ({ path: filePath, revision }));
    const result = await turn.revert([], { files, kind: 'files' });
    expect(result).toMatchObject({
      error: { code: 'changeset.stale', message: '"later.txt" changed since this turn.' },
      ok: false,
    });
    expect(await read('src/a.txt')).toBe('one\nTWO\nthree\n');
    expect(await read('later.txt')).toBe('after the turn\n');
  });

  it('reverts nothing while the thread has a run in progress', async () => {
    const turn = await settledTurn({ running: true });
    expect(Object.values(await turn.offered())).toEqual(new Array(5).fill([]));
    const drawn = (await turn.view()).files.find((file) => file.path === 'src/a.txt');
    const result = await turn.revert([], {
      files: drawn ? [{ path: drawn.path, revision: drawn.revision }] : [],
      kind: 'files',
    });
    expect(result).toMatchObject({ error: { code: 'changeset.run-active' }, ok: false });
    expect(await read('src/a.txt')).toBe('one\nTWO\nthree\n');
  });

  it('reverts nothing in a folder that is no longer where the turn found it', async () => {
    const turn = await settledTurn({ mountedAt: path.join(base, 'elsewhere') });
    expect(Object.values(await turn.offered())).toEqual(new Array(5).fill([]));
    const result = await turn.revert(['src/a.txt']);
    expect(result).toMatchObject({ error: { code: 'changeset.stale' }, ok: false });
    expect(await read('src/a.txt')).toBe('one\nTWO\nthree\n');
  });

  it('pairs a moved file with where it came from, and reverts both paths', async () => {
    await mkdir(path.join(root, 'docs'));
    await write('docs/guide.md', GUIDE);
    const turn = await settledTurn({ during: moveTheGuide });
    const [moved, ...others] = (await turn.view()).files;
    expect(others).toEqual([]);
    expect(moved).toMatchObject({
      actions: ['revert'],
      additions: 1,
      deletions: 1,
      oldPath: 'docs/guide.md',
      path: 'docs/manual.md',
      status: 'renamed',
    });
    expect(moved?.patch).toContain('rename from docs/guide.md\nrename to docs/manual.md\n');

    expect(await turn.revert(['docs/manual.md'])).toEqual({
      ok: true,
      value: { paths: ['docs/guide.md', 'docs/manual.md'] },
    });
    expect(await read('docs/guide.md')).toBe(GUIDE);
    await expect(read('docs/manual.md')).rejects.toThrow('ENOENT');
    expect(await turn.offered()).toEqual({ 'docs/manual.md': [] });
  });

  it('offers no revert of a moved file once its old path is written again', async () => {
    await mkdir(path.join(root, 'docs'));
    await write('docs/guide.md', GUIDE);
    const turn = await settledTurn({ during: moveTheGuide });
    const drawn = await turn.view();
    await write('docs/guide.md', 'a new guide\n');
    expect(await turn.offered()).toEqual({ 'docs/manual.md': [] });
    const result = await turn.revert([], {
      files: drawn.files.map(({ path: filePath, revision }) => ({ path: filePath, revision })),
      kind: 'files',
    });
    expect(result).toMatchObject({
      error: { code: 'changeset.stale', message: '"docs/guide.md" changed since this turn.' },
      ok: false,
    });
    expect(await read('docs/guide.md')).toBe('a new guide\n');
    expect(await read('docs/manual.md')).toBe(GUIDE.replace('four', '4'));
  });

  it('takes no single hunk', async () => {
    const turn = await settledTurn();
    const result = await turn.revert([], {
      hunks: ['@@ -1,3 +1,3 @@\n'],
      kind: 'hunks',
      path: 'src/a.txt',
    });
    expect(result).toMatchObject({ error: { code: 'changeset.action-unavailable' }, ok: false });
    expect(await read('src/a.txt')).toBe('one\nTWO\nthree\n');
  });
});
