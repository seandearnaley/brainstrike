import { CheckpointBlockedError } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { checkedTruncateCheckpoint } from '../src/checked-checkpoint.js';

function connection(result: unknown): Pick<Database.Database, 'pragma'> {
  return {
    pragma: vi.fn((source: string): unknown => {
      if (source === 'busy_timeout') {
        return 5000;
      }
      if (source === 'wal_checkpoint(TRUNCATE)') {
        return result;
      }
      return undefined;
    }),
  };
}

describe('checked nonblocking purge checkpoint', () => {
  it('acknowledges only a fully truncated WAL and restores the original timeout', () => {
    const db = connection([{ busy: 0, checkpointed: 0, log: 0 }]);
    checkedTruncateCheckpoint(db);
    expect(db.pragma).toHaveBeenNthCalledWith(1, 'busy_timeout', { simple: true });
    expect(db.pragma).toHaveBeenNthCalledWith(2, 'busy_timeout=0');
    expect(db.pragma).toHaveBeenNthCalledWith(3, 'wal_checkpoint(TRUNCATE)');
    expect(db.pragma).toHaveBeenNthCalledWith(4, 'busy_timeout=5000');
  });

  it.each([
    { result: [{ busy: 1, checkpointed: 0, log: 12 }] },
    { result: [{ busy: 0, checkpointed: 4, log: 4 }] },
    { result: [] },
    {
      result: [
        { busy: 0, checkpointed: 0, log: 0 },
        { busy: 0, checkpointed: 0, log: 0 },
      ],
    },
  ])('refuses an incomplete checkpoint and restores the timeout: $result', ({ result }) => {
    const db = connection(result);
    expect(() => checkedTruncateCheckpoint(db)).toThrow(CheckpointBlockedError);
    expect(db.pragma).toHaveBeenLastCalledWith('busy_timeout=5000');
  });

  it('preserves a checkpoint exception and restores the timeout', () => {
    const failure = new Error('Native checkpoint failed');
    const db = connection([]);
    vi.mocked(db.pragma).mockImplementation((source: string): unknown => {
      if (source === 'busy_timeout') {
        return 1234;
      }
      if (source === 'wal_checkpoint(TRUNCATE)') {
        throw failure;
      }
      return undefined;
    });
    expect(() => checkedTruncateCheckpoint(db)).toThrow(failure);
    expect(db.pragma).toHaveBeenLastCalledWith('busy_timeout=1234');
  });
});
