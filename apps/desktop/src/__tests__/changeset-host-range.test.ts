/**
 * A host rewind preview's run range follows Core's restore-point rule
 * (`thread-rewind.ts` `restorePoints`): the FROM run's turn start per root,
 * and a root first seen in a later run restores to its first turn start
 * after it; a failed capture fails the whole range.
 */
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { expect, test } from 'vitest';
import { createHostThreadTurns } from '../assistant-server/changeset-host-turns';

const THREAD = 'thread-1';
const oid = (digit: string) => digit.repeat(40);
const ROOT_A = { rootId: 'root-a', rootPath: '/workspace/a' };
const ROOT_B = { rootId: 'root-b', rootPath: '/workspace/b' };

function turnStart(
  seq: number,
  runId: string,
  roots: readonly { commitOid: string; rootId: string; rootPath: string }[]
): HostLogRow {
  return HostLogRowSchema.parse({
    event: { boundary: 'turn-start', roots, runId, type: 'workspace.snapshot.recorded' },
    seq,
    threadId: THREAD,
  });
}

function turns(rows: readonly HostLogRow[]) {
  return createHostThreadTurns({
    listThreads: async () => new Set([THREAD]),
    readRows: async (_threadId, fromSeq) => rows.filter((row) => row.seq > fromSeq),
  });
}

test('each root restores to the FROM run’s turn start, or to its first turn start after it', async () => {
  const rows = [
    turnStart(1, 'run-1', [{ ...ROOT_A, commitOid: oid('1') }]),
    turnStart(2, 'run-2', [{ ...ROOT_A, commitOid: oid('2') }]),
    turnStart(3, 'run-3', [
      { ...ROOT_A, commitOid: oid('3') },
      { ...ROOT_B, commitOid: oid('4') },
    ]),
  ];
  await expect(turns(rows).rangeTargetsOf(THREAD, 'run-2')).resolves.toEqual({
    ok: true,
    value: {
      attribution: null,
      targets: [
        { ...ROOT_A, fromOid: oid('2'), to: { worktree: true } },
        { ...ROOT_B, fromOid: oid('4'), to: { worktree: true } },
      ],
    },
  });
});

test('a range whose FROM run has no turn start, or crosses a failed capture, is refused', async () => {
  const failed = [
    turnStart(1, 'run-1', [{ ...ROOT_A, commitOid: oid('1') }]),
    turnStart(2, 'run-2', [{ ...ROOT_B, commitOid: oid('0') }]),
  ];
  const crossed = await turns(failed).rangeTargetsOf(THREAD, 'run-1');
  expect(!crossed.ok && crossed.error).toMatch(/^changeset-snapshot-capture-failed: /);
  const missing = await turns(failed).rangeTargetsOf(THREAD, 'run-9');
  expect(!missing.ok && missing.error).toMatch(/^changeset-snapshot-missing: /);
});
