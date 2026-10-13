import { describe, expect, test } from 'vitest';
import { ThreadLedgerFold } from '../src/ledger-projection.js';
import { HostLedgerThreadSchema } from '../src/ledger-wire.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';
import recording from './fixtures/recorded-undo-ledger.json' with { type: 'json' };

// Actual 54debb storage acceptance F2/F3 committed rows (13 Oct 2026).
// Only start/finish/verdict rows are retained; unrelated admission snapshots omitted.
const rows = recording.map((row) => HostLogRowSchema.parse(row));
const threadId = '9ba3c8e9-847e-4118-8a1f-758ec9aa4fd7';
const fullRun = '64263838-b201-4d03-b6d2-4d245a92c684';
const partialRun = 'f9745466-0b46-469e-b131-eeb96cd7ebaa';

function read(fold: ThreadLedgerFold) {
  return HostLedgerThreadSchema.parse({ ...fold.read(), threadId });
}

function replay(log: readonly HostLogRow[]): ThreadLedgerFold {
  const fold = new ThreadLedgerFold();
  for (const row of log) {
    fold.apply(row);
  }
  return fold;
}

describe('committed verdicts in the host ledger', () => {
  test('recorded full and partial undo labels survive ledger wire transport and replay', () => {
    const fold = replay(rows);
    expect(read(fold).runs).toEqual([
      expect.objectContaining({
        outcomeDetail: '1/1 edits reverted',
        outcomeSource: 'edit_revert',
        outcomeVerdict: 'failed',
        runId: fullRun,
        status: 'completed',
      }),
      expect.objectContaining({
        outcomeDetail: '1/2 edits reverted',
        outcomeSource: 'edit_revert',
        outcomeVerdict: 'mixed',
        runId: partialRun,
        status: 'completed',
      }),
    ]);
    expect(read(replay(rows))).toEqual(read(fold));
  });

  test('an explicit user verdict survives later derived updates across incremental reads', () => {
    const fold = replay(rows);
    const user = HostLogRowSchema.parse({
      event: { runId: fullRun, source: 'user', type: 'run.verdict', verdict: 'succeeded' },
      seq: 93,
      threadId,
      ts: 1_791_892_282_400,
    });
    fold.apply(user);
    expect(read(fold).runs[0]).toMatchObject({
      outcomeDetail: null,
      outcomeSource: 'user',
      outcomeVerdict: 'succeeded',
    });
    const derived = rows.find((row) => row.event.type === 'run.verdict');
    if (!derived) {
      throw new Error('Recording has no undo verdict');
    }
    fold.apply({ ...derived, seq: 94 });
    expect(read(fold).runs[0]).toMatchObject({
      outcomeDetail: null,
      outcomeSource: 'user',
      outcomeVerdict: 'succeeded',
    });
    expect(read(replay([...rows, user, { ...derived, seq: 94 }]))).toEqual(read(fold));
  });
});
