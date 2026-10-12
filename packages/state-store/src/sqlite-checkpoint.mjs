// @ts-check
// The checkpoint that makes deletes physical (M0-A2 src/sqlite.ts). With secure_delete=ON a deleted or overwritten row
// is zeroed in its page, but the old page image still sits in the WAL until every frame is copied back and the WAL is
// truncated. A reader that pins the WAL stops that, and the purge must then fail loudly, never report success while the
// old bytes are still on disk (M0-A2 finding 3; test i1 "a reader pinning the WAL").

export class CheckpointBlockedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CheckpointBlockedError';
  }
}

/**
 * Copy every WAL frame into the main file and truncate the WAL to 0 bytes. Throws CheckpointBlockedError when a reader
 * pins the WAL (SQLite reports busy=1).
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function checkpointTruncate(db) {
  const rows = /** @type {Array<{ busy: number; log: number; checkpointed: number }>} */ (
    db.pragma('wal_checkpoint(TRUNCATE)')
  );
  const r = rows[0];
  // No row, or busy=1: a reader pins the WAL.
  if (r?.busy !== 0) {
    throw new CheckpointBlockedError(
      `wal_checkpoint(TRUNCATE) on ${db.name} could not complete (a reader pins the WAL): ${JSON.stringify(r)}`
    );
  }
}
