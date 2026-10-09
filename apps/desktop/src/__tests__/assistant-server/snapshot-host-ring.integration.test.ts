/**
 * Real-git coverage for host threads' snapshot retention ring (BST-1977).
 * A host thread's turns are recorded in the host's log, never the ledger, so
 * the startup GC trims each host chain from shadow git alone: the newest
 * `turn-start` commits per chain, cut with the same shallow boundary and
 * `gc --prune=now` as legacy turns. Every prune in a root re-lists every
 * surviving host chain's base, so a chain cut by an earlier sweep stays
 * walkable when a later sweep prunes the same root for another chain.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import { listThreadSnapshotChain } from '../../assistant-server/snapshot-chains';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import type { SnapshotRepository } from '../../assistant-server/snapshot-repository';
import {
  createSnapshotService,
  type ShadowRepoHandle,
  type SnapshotService,
} from '../../assistant-server/snapshot-service';
import { runSnapshotStartupGc } from '../../assistant-server/snapshot-startup-gc';

const execFileAsync = promisify(execFile);
const HEAVY_TIMEOUT_MS = 120_000;
const ROOT_ID = 'root-host-ring';
const RING_THREAD = 'host-ring-thread';
const SHORT_THREAD = 'host-short-thread';

let rootPath: string;
let snapshotsBase: string;
let service: SnapshotService;
let handle: ShadowRepoHandle;

beforeEach(async () => {
  rootPath = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-host-ring-root-'))
  );
  snapshotsBase = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-host-ring-shadow-'))
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

interface HostTurn {
  readonly end: string;
  readonly start: string;
}

/** One host turn in the root: its start and end snapshots, each with its own content. */
async function hostTurn(threadId: string, turn: number): Promise<HostTurn> {
  const file = path.join(rootPath, 'file.txt');
  const runId = `${threadId}-run-${turn}`;
  await fsPromises.writeFile(file, `${threadId} ${turn} start\n`);
  const start = await service.snapshot(handle, { kind: 'turn-start', runId, threadId });
  await fsPromises.writeFile(file, `${threadId} ${turn} end\n`);
  const end = await service.snapshot(handle, { kind: 'turn-end', runId, threadId });
  return { end: end.commitOid, start: start.commitOid };
}

async function hostTurns(threadId: string, from: number, to: number): Promise<HostTurn[]> {
  const turns: HostTurn[] = [];
  for (let turn = from; turn <= to; turn += 1) {
    turns.push(await hostTurn(threadId, turn));
  }
  return turns;
}

async function blobExists(oid: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['--git-dir', handle.gitDir, 'cat-file', '-e', `${oid}:file.txt`]);
    return true;
  } catch {
    return false;
  }
}

/** The startup GC over a profile with no legacy ledger rows, both host threads live. */
function sweep(turnRing?: number) {
  const unused = (): never => {
    throw new Error('no ledger row exists in this profile');
  };
  const db: EditCheckpointDatabase = {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes('SELECT DISTINCT thread_id') || sql.includes('SELECT DISTINCT ON')) {
        return { rows: [] };
      }
      throw new Error(`unexpected GC query: ${sql}`);
    },
  };
  return runSnapshotStartupGc({
    db,
    isRootPathAccessible: async () => true,
    liveRoots: [{ path: rootPath, rootId: ROOT_ID }],
    readHostThreadIds: async () => new Set([RING_THREAD, SHORT_THREAD]),
    readThreadChain: (repo, threadId) =>
      listThreadSnapshotChain(execFileSnapshotGitRunner, repo, threadId),
    snapshotRepository: {
      deleteByIds: unused,
      deleteForThread: unused,
      insertSnapshot: unused,
      latestSnapshotFor: unused,
      rootsForThread: unused,
      snapshotsForThread: unused,
    } satisfies SnapshotRepository,
    snapshotService: service,
    ...(turnRing === undefined ? {} : { turnRing }),
  });
}

function chainOf(threadId: string) {
  return listThreadSnapshotChain(execFileSnapshotGitRunner, handle, threadId);
}

test('a host thread of 60 turns keeps its newest 50, which still resolve, and loses the rest', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  const turns = await hostTurns(RING_THREAD, 1, 60);
  const short = await hostTurns(SHORT_THREAD, 1, 3);

  const report = await sweep();

  expect(report.failures).toEqual([]);
  expect(report.hostRingTrimmed).toEqual([{ rootId: ROOT_ID, threadId: RING_THREAD }]);
  expect(report.historyPrunedRoots).toEqual([ROOT_ID]);
  const chain = await chainOf(RING_THREAD);
  expect(chain.filter((entry) => entry.kind === 'turn-start')).toHaveLength(50);
  expect(chain[0]).toEqual({
    commitOid: turns[59]?.end,
    kind: 'turn-end',
    runId: `${RING_THREAD}-run-60`,
  });
  expect(chain.at(-1)).toEqual({
    commitOid: turns[10]?.start,
    kind: 'turn-start',
    runId: `${RING_THREAD}-run-11`,
  });
  // Turn 10 is past the ring: its snapshots are reclaimed.
  expect(await blobExists(turns[9]?.start ?? '')).toBe(false);
  expect(await blobExists(turns[9]?.end ?? '')).toBe(false);
  // Turn 11, the oldest kept, is still a restore target: its tree and its diff resolve.
  const oldestKept = turns[10];
  if (!oldestKept) {
    throw new Error('the fixture made 60 turns');
  }
  expect(await service.snapshotFileHashes(handle, oldestKept.start)).toHaveProperty('size', 1);
  const diffs = await service.diffRefs(handle, oldestKept.start, oldestKept.end);
  expect(diffs.map((diff) => diff.path)).toEqual(['file.txt']);
  // A host chain within the ring is untouched.
  expect((await chainOf(SHORT_THREAD)).map((entry) => entry.commitOid)).toEqual(
    [...short].reverse().flatMap((turn) => [turn.end, turn.start])
  );
});

test('a chain cut by an earlier sweep stays walkable when a later sweep prunes the root for another chain', {
  timeout: HEAVY_TIMEOUT_MS,
}, async () => {
  // Ring of 3: the ring thread is cut first, then only the short thread grows past it.
  await hostTurns(RING_THREAD, 1, 5);
  await hostTurns(SHORT_THREAD, 1, 2);
  const first = await sweep(3);
  expect(first.hostRingTrimmed).toEqual([{ rootId: ROOT_ID, threadId: RING_THREAD }]);
  const cutChain = await chainOf(RING_THREAD);
  expect(cutChain.filter((entry) => entry.kind === 'turn-start')).toHaveLength(3);

  await hostTurns(SHORT_THREAD, 3, 6);
  const second = await sweep(3);

  expect(second.failures).toEqual([]);
  expect(second.hostRingTrimmed).toEqual([{ rootId: ROOT_ID, threadId: SHORT_THREAD }]);
  expect(second.historyPrunedRoots).toEqual([ROOT_ID]);
  // The earlier cut was re-listed: the ring thread's kept chain is whole and its parents exist.
  expect(await chainOf(RING_THREAD)).toEqual(cutChain);
  await expect(
    execFileAsync('git', ['--git-dir', handle.gitDir, 'fsck', '--connectivity-only'])
  ).resolves.toBeDefined();
  const ringStart = cutChain.at(-1)?.commitOid ?? '';
  const ringEnd = cutChain[0]?.commitOid ?? '';
  const ringDiff = await service.diffRefs(handle, ringStart, ringEnd);
  expect(ringDiff.map((diff) => diff.path)).toEqual(['file.txt']);
  expect((await chainOf(SHORT_THREAD)).filter((entry) => entry.kind === 'turn-start')).toHaveLength(
    3
  );
});
