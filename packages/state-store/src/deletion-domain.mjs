// @ts-check
// The writer's side of purge and thread deletion, run by the desktop writer worker. Each function runs on the writing
// connection; the orchestration (`state-deletion.ts`) calls them in its order, between the derived index's steps.
import { executeMemoryRequest, threadMemoryResources } from './memory-domain.mjs';

/**
 * Records a purge or thread delete before it starts, so the next open completes one a crash interrupted. A retry
 * after a failed purge finds the event already tombstoned, so the blob hashes the first attempt recorded are kept;
 * those are returned. The thread's memory resources are recorded too, before its rows go.
 * @param {import('better-sqlite3').Database} db
 * @param {{ threadId: string, seq: number, hashes: string, operation: 'event' | 'thread' }} intent
 * @returns {string} the recorded hashes, as JSON
 */
export function recordDeletionIntent(db, intent) {
  db.prepare(
    'INSERT INTO purge_intent (thread_id, seq, hashes, operation, memory_resources) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id, seq) DO NOTHING'
  ).run(
    intent.threadId,
    intent.seq,
    intent.hashes,
    intent.operation === 'thread' ? 'thread' : 'event',
    JSON.stringify(threadMemoryResources(db, intent.threadId))
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
 * The memory resources the thread's intent recorded before its rows go.
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {number} seq
 * @returns {string[]}
 */
export function intentMemoryResources(db, threadId, seq) {
  const intent = /** @type {{ memory_resources:string } | undefined} */ (
    db
      .prepare('SELECT memory_resources FROM purge_intent WHERE thread_id=? AND seq=?')
      .get(threadId, seq)
  );
  if (!intent) {
    throw new Error('Memory erasure requires the existing purge intent');
  }
  return JSON.parse(intent.memory_resources);
}

/**
 * Every memory resource a recorded intent names: the memory lanes a replay enters.
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function allIntentMemoryResources(db) {
  const recorded = /** @type {string[]} */ (
    db.prepare('SELECT memory_resources FROM purge_intent').pluck().all()
  );
  return [...new Set(recorded.flatMap((resources) => JSON.parse(resources)))];
}

/**
 * Erases what the thread contributed to memory, for the resources its intent recorded before FK deletion.
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {number} seq
 * @param {'clear' | 'detach-thread'} sharedResource
 * @param {readonly import('./memory-types.ts').MemorySharedObservations[]} [detached] each resource's shared
 *   observations without the thread's sections, as the memory calculator detached them
 */
export function eraseThreadMemory(db, threadId, seq, sharedResource, detached) {
  for (const resourceId of intentMemoryResources(db, threadId, seq)) {
    executeMemoryRequest(
      db,
      { operation: 'purge-thread', resourceId, sharedResource, threadId },
      detached?.find((entry) => entry.resourceId === resourceId)
    );
  }
}

/**
 * Tombstones event `seq` and erases what the thread may have contributed to shared memory, in one transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./run-log.mjs').RunLog} log
 * @param {string} threadId
 * @param {number} seq
 * @param {string} tombstone
 * @param {() => void} [inTransaction] runs last inside the transaction (the crash harness)
 */
export function purgeEvent(db, log, threadId, seq, tombstone, inTransaction) {
  log.purge(threadId, seq, tombstone, () => {
    eraseThreadMemory(db, threadId, seq, 'clear');
    inTransaction?.();
  });
}

/**
 * Deletes the thread's rows. Shared resource memory is kept, as legacy did, minus the thread's own sections.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./run-log.mjs').RunLog} log
 * @param {string} threadId
 * @param {readonly import('./memory-types.ts').MemorySharedObservations[]} detached
 */
export function deleteThreadTruth(db, log, threadId, detached) {
  log.deleteThread(threadId, () => eraseThreadMemory(db, threadId, 0, 'detach-thread', detached));
}

/**
 * Threads whose every row verified: purge GC and catch-up read only these.
 * @param {import('./run-log.mjs').RunLog} log
 */
export function okThreads(log) {
  return log.threads().filter((thread) => log.status(thread).kind === 'ok');
}

/**
 * Blobs the source catalog's files still name, which GC keeps.
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function sourceBlobRefs(db) {
  return /** @type {string[]} */ (
    db.prepare('SELECT DISTINCT content_hash FROM file_records').pluck().all()
  );
}

/**
 * Blobs the source catalog retired, waiting for GC.
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function sourceGcCandidates(db) {
  return /** @type {string[]} */ (db.prepare('SELECT hash FROM source_blob_gc').pluck().all());
}

/** @param {import('better-sqlite3').Database} db @param {readonly string[]} hashes */
export function acknowledgeSourceGc(db, hashes) {
  db.prepare('DELETE FROM source_blob_gc WHERE hash IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(hashes)
  );
}
