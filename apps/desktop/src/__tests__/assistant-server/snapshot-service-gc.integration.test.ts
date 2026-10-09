/**
 * Real-git coverage for the T4 SnapshotService additions (BST-1164):
 * `restorePathsFromSnapshot` (the checkpoint-undo seam),
 * `listSnapshotThreadIds` (startup-GC ref inventory), and `pruneHistory`
 * (shallow-cut + `git gc` retention). Same harness posture as
 * `snapshot-service.integration.test.ts`: REAL temp dirs, the production
 * `execFileSnapshotGitRunner`, no git mocking.
 */

import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSnapshotGitRunner, SnapshotGitError } from '../../assistant-server/snapshot-git';
import {
  createSnapshotService,
  type ShadowRepoHandle,
  type SnapshotService,
} from '../../assistant-server/snapshot-service';

const execFileAsync = promisify(execFile);
const HEAVY_TIMEOUT_MS = 60_000;

const ROOT_ID = 'root-gc';
const THREAD = 'thread-gc';

let rootPath: string;
let snapshotsBase: string;
let service: SnapshotService;
let handle: ShadowRepoHandle;

async function write(relative: string, content: string): Promise<void> {
  const absolute = path.join(rootPath, relative);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, content, 'utf8');
}

async function readOrNull(relative: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path.join(rootPath, relative), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function snap(threadId = THREAD): Promise<string> {
  const { commitOid } = await service.snapshot(handle, { kind: 'turn-start', threadId });
  return commitOid;
}

async function blobExists(oid: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['--git-dir', handle.gitDir, 'cat-file', '-e', `${oid}:file.txt`]);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  rootPath = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-gc-root-'))
  );
  snapshotsBase = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-gc-shadow-'))
  );
  service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: snapshotsBase,
  });
  handle = await service.ensureShadowRepo({ path: rootPath, rootId: ROOT_ID });
});

afterEach(async () => {
  await fsPromises.rm(rootPath, { force: true, recursive: true });
  await fsPromises.rm(snapshotsBase, { force: true, recursive: true });
});

describe('restorePathsFromSnapshot', () => {
  it('restores present paths, deletes snapshot-absent paths (with ancestor pruning), one outcome per input', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('kept/a.txt', 'A@start\n');
    const oid = await snap();
    await write('kept/a.txt', 'A@later\n');
    await write('scaffold/deep/new.txt', 'created later\n');

    const outcomes = await service.restorePathsFromSnapshot(handle, oid, [
      { expectAbsent: false, path: 'kept/a.txt' },
      { expectAbsent: true, path: 'scaffold/deep/new.txt' },
    ]);
    expect(outcomes).toEqual([
      { outcome: 'restored', path: 'kept/a.txt' },
      { outcome: 'deleted', path: 'scaffold/deep/new.txt' },
    ]);
    expect(await readOrNull('kept/a.txt')).toBe('A@start\n');
    expect(await readOrNull('scaffold/deep/new.txt')).toBeNull();
    await expect(fsPromises.stat(path.join(rootPath, 'scaffold'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses (uncovered, untouched) a snapshot-absent path the caller expected PRESENT', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // A gitignored file: staged `add -A` respects the ignore, so the snapshot
    // never contains it — absence here is a coverage hole, not "turn-created".
    await write('.gitignore', 'secret.env\n');
    await write('secret.env', 'S3CR3T@start\n');
    const oid = await snap();
    await write('secret.env', 'S3CR3T@edited\n');

    const outcomes = await service.restorePathsFromSnapshot(handle, oid, [
      { expectAbsent: false, path: 'secret.env' },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: 'uncovered', path: 'secret.env' });
    if (outcomes[0]?.outcome === 'uncovered') {
      expect(outcomes[0].message).toContain('not covered by the snapshot');
    }
    // The live file is UNTOUCHED — deleting it would have destroyed the only
    // copy (the pre-edit bytes exist nowhere).
    expect(await readOrNull('secret.env')).toBe('S3CR3T@edited\n');
  });

  it('treats an already-absent snapshot-absent path as deleted (idempotent), and rejects unsafe paths', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'x\n');
    const oid = await snap();

    const outcomes = await service.restorePathsFromSnapshot(handle, oid, [
      { expectAbsent: true, path: 'never-existed.txt' },
    ]);
    expect(outcomes).toEqual([{ outcome: 'deleted', path: 'never-existed.txt' }]);

    await expect(
      service.restorePathsFromSnapshot(handle, oid, [{ expectAbsent: true, path: '../escape.txt' }])
    ).rejects.toBeInstanceOf(SnapshotGitError);
    await expect(
      service.restorePathsFromSnapshot(handle, oid, [{ expectAbsent: true, path: '/abs.txt' }])
    ).rejects.toBeInstanceOf(SnapshotGitError);
  });

  it('a glob-looking journal path matches itself literally, never expands', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('star*.txt', 'literal star\n');
    await write('starABC.txt', 'not this one\n');
    const oid = await snap();
    await write('star*.txt', 'changed\n');
    await write('starABC.txt', 'changed too\n');

    const outcomes = await service.restorePathsFromSnapshot(handle, oid, [
      { expectAbsent: false, path: 'star*.txt' },
    ]);
    expect(outcomes).toEqual([{ outcome: 'restored', path: 'star*.txt' }]);
    expect(await readOrNull('star*.txt')).toBe('literal star\n');
    // The sibling the glob WOULD have matched stays untouched.
    expect(await readOrNull('starABC.txt')).toBe('changed too\n');
  });
});

describe('listSnapshotThreadIds', () => {
  it('inventories exactly the per-thread lineage refs', { timeout: HEAVY_TIMEOUT_MS }, async () => {
    expect(await service.listSnapshotThreadIds(handle)).toEqual([]);
    await write('file.txt', 'v1\n');
    await snap('thread-a');
    await write('file.txt', 'v2\n');
    await snap('thread-b');
    expect([...(await service.listSnapshotThreadIds(handle))].sort()).toEqual([
      'thread-a',
      'thread-b',
    ]);
    await service.pruneThread(handle, 'thread-a');
    expect(await service.listSnapshotThreadIds(handle)).toEqual(['thread-b']);
  });
});

describe('pruneHistory', () => {
  it('reclaims blobs behind the shallow boundary while kept history stays diffable and extendable', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    const oids: string[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      await write('file.txt', `content-${turn}\n`);
      oids.push(await snap());
    }
    const [oldest, second, third, fourth] = oids;
    if (!(oldest && second && third && fourth)) {
      throw new Error('fixture must produce four snapshots');
    }

    // Keep the newest two turns: boundary at the third commit.
    await service.pruneHistory(handle, [third]);

    expect(await blobExists(third)).toBe(true);
    expect(await blobExists(fourth)).toBe(true);
    // Pruned-turn blobs are actually GONE from the object store.
    expect(await blobExists(oldest)).toBe(false);
    expect(await blobExists(second)).toBe(false);

    // Kept range still diffs, and new snapshots stack on the cut chain.
    const diffs = await service.diffRefs(handle, third, fourth);
    expect(diffs.map((diff) => diff.path)).toEqual(['file.txt']);
    await write('file.txt', 'content-5\n');
    const fifth = await snap();
    expect(fifth).toMatch(/^[0-9a-f]{40,64}$/);

    // A second trim (empty boundary set = remove the cut) stays healthy.
    await service.pruneHistory(handle, [fifth]);
    expect(await blobExists(fourth)).toBe(false);
    expect(await blobExists(fifth)).toBe(true);
  });

  it("keeps a chain outside the boundaries whole: a host thread's turns survive a legacy trim", {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // A host thread's turns are recorded in the host's log, never the ledger,
    // so its chain is never among the boundaries the startup GC cuts at.
    await write('file.txt', 'host-1\n');
    const hostStart = await snap('host-thread');
    await write('file.txt', 'host-2\n');
    const hostEnd = await snap('host-thread');
    const legacy: string[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      await write('file.txt', `legacy-${turn}\n`);
      legacy.push(await snap('legacy-thread'));
    }
    const [legacyOldest, , legacyNewest] = legacy;
    if (!(legacyOldest && legacyNewest)) {
      throw new Error('fixture must produce three legacy snapshots');
    }

    await service.pruneHistory(handle, [legacyNewest]);

    expect(await blobExists(legacyOldest)).toBe(false);
    expect(await blobExists(hostStart)).toBe(true);
    expect(await blobExists(hostEnd)).toBe(true);
    const diffs = await service.diffRefs(handle, hostStart, hostEnd);
    expect(diffs.map((diff) => diff.path)).toEqual(['file.txt']);
  });
});
