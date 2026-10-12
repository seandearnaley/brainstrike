import { CheckpointBlockedError } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { decoder } from './contracts.js';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeCount = decoder(count);

/** Existing owned-writer purge boundary; never checkpoint ordinary publication. */
export function checkedTruncateCheckpoint(db: Pick<Database.Database, 'pragma'>): void {
  const busyTimeout = decodeCount(db.pragma('busy_timeout', { simple: true }));
  db.pragma('busy_timeout=0');
  try {
    const rows = decoder(
      Schema.Array(Schema.Struct({ busy: count, checkpointed: Schema.Int, log: Schema.Int }))
    )(db.pragma('wal_checkpoint(TRUNCATE)'));
    if (
      rows.length !== 1 ||
      rows[0]?.busy !== 0 ||
      rows[0].log !== 0 ||
      rows[0].checkpointed !== 0
    ) {
      throw new CheckpointBlockedError('Derived purge checkpoint is blocked by a pinned reader');
    }
  } finally {
    db.pragma(`busy_timeout=${busyTimeout}`);
  }
}
