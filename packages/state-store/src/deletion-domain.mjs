// @ts-check
// The writer's side of purge and thread deletion, run by the desktop writer worker. Each function runs on the writing
// connection; the orchestration (`state-deletion.ts`) calls them in its order, between the derived index's steps.

/**
 * Records a purge or thread delete before it starts, so the next open completes one a crash interrupted. A retry
 * after a failed purge finds the event already tombstoned, so the blob hashes the first attempt recorded are kept;
 * those are returned.
 * @param {import('better-sqlite3').Database} db
 * @param {{ threadId: string, seq: number, hashes: string, operation: 'event' | 'thread' }} intent
 * @returns {string} the recorded hashes, as JSON
 */
export function recordDeletionIntent(db, intent) {
  db.prepare(
    'INSERT INTO purge_intent (thread_id, seq, hashes, operation) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, seq) DO NOTHING'
  ).run(
    intent.threadId,
    intent.seq,
    intent.hashes,
    intent.operation === 'thread' ? 'thread' : 'event'
  );
  const row = /** @type {{ hashes: string }} */ (
    db
      .prepare('SELECT hashes FROM purge_intent WHERE thread_id = ? AND seq = ?')
      .get(intent.threadId, intent.seq)
  );
  return row.hashes;
}

/**
 * Every recorded intent, oldest first.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ threadId: string, seq: number, hashes: string, operation: 'event' | 'thread' }[]}
 */
export function deletionIntents(db) {
  return /** @type {{ threadId: string, seq: number, hashes: string, operation: 'event' | 'thread' }[]} */ (
    db
      .prepare(
        'SELECT thread_id AS threadId, seq, hashes, operation FROM purge_intent ORDER BY rowid'
      )
      .all()
  );
}

/** @param {import('better-sqlite3').Database} db @param {string} threadId @param {number} seq */
export function deleteDeletionIntent(db, threadId, seq) {
  db.prepare('DELETE FROM purge_intent WHERE thread_id = ? AND seq = ?').run(threadId, seq);
}

/**
 * Threads whose every row verified: purge GC and catch-up read only these.
 * @param {import('./run-log.mjs').RunLog} log
 */
export function okThreads(log) {
  return log.threads().filter((thread) => log.status(thread).kind === 'ok');
}
