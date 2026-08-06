/**
 * Unit coverage for the pure turn-bracket derivation (BST-1164 T2) — the
 * WRONG-BRACKET class from the W7 review: a ledger written by the pre-fix
 * abandoned-turn close stamps one run id as BOTH turn N's `endRunId` and turn
 * N+1's `startRunId`. `findBracketByRunId` must prefer the START match so a
 * colliding id can never resolve BACKWARDS into the abandoned turn —
 * checkpoint undo derives its restore baseline from this lookup, so a
 * backwards match is a wrong-baseline destructive restore, not a display bug.
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshotRow } from '../../assistant-server/snapshot-repository';
import {
  findBracketByRunId,
  resolveSnapshotTurnBrackets,
} from '../../assistant-server/snapshot-turn-ledger';

const THREAD = 'thread-ledger';

function row(
  index: number,
  kind: WorkspaceSnapshotRow['kind'],
  runId: string,
  rootId = 'root-a'
): WorkspaceSnapshotRow {
  return {
    commitOid: `oid-${index}`,
    createdAt: String(index).padStart(8, '0'),
    id: `row-${index}`,
    kind,
    rootId,
    rootPath: `/tmp/${rootId}`,
    runId,
    threadId: THREAD,
  };
}

describe('findBracketByRunId', () => {
  it('resolves a run id to the bracket it STARTS, never backwards into a legacy bracket that ends with the same id', () => {
    // The pre-fix abandoned-turn close: turn 1 (run-1) was paused then
    // superseded, and its turn-end rows were stamped with the INCOMING leg's
    // id (run-9) — the exact collision shape durable ledgers written before
    // the fix still contain.
    const brackets = resolveSnapshotTurnBrackets([
      row(1, 'turn-start', 'run-1'),
      row(2, 'turn-end', 'run-9'),
      row(3, 'turn-start', 'run-9'),
      row(4, 'turn-end', 'run-9'),
    ]);
    expect(brackets).toHaveLength(2);

    const resolved = findBracketByRunId(brackets, 'run-9');
    expect(resolved).not.toBeNull();
    expect(resolved?.startRunId).toBe('run-9');
    // run-1 still resolves to its own (abandoned) bracket.
    expect(findBracketByRunId(brackets, 'run-1')?.startRunId).toBe('run-1');
  });

  it('still matches by end run id when no bracket starts with the id (mid-thread end anchors)', () => {
    const brackets = resolveSnapshotTurnBrackets([
      row(1, 'turn-start', 'run-1'),
      row(2, 'turn-end', 'run-2'),
    ]);
    expect(findBracketByRunId(brackets, 'run-2')?.startRunId).toBe('run-1');
    expect(findBracketByRunId(brackets, 'run-none')).toBeNull();
  });
});
