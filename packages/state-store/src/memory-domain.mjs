// @ts-check
// Called on the existing writer connection. Studio registers this migration and
// dispatcher; this module opens no DB and creates no transcript or lease owner.
export const MEMORY_SCHEMA = `
CREATE TABLE brainstrike_memory_scopes (
  resource_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
CREATE TABLE brainstrike_memory_entities (
  kind TEXT NOT NULL CHECK (kind IN ('thread','resource','observation')),
  id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES brainstrike_memory_scopes(resource_id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  PRIMARY KEY (kind,id)
) STRICT;
CREATE INDEX brainstrike_memory_entities_resource ON brainstrike_memory_entities(resource_id,kind);
CREATE INDEX brainstrike_memory_entities_thread ON brainstrike_memory_entities(thread_id);
`;

export class MemoryRevisionConflictError extends Error {
  /** @param {number} expected @param {number} actual */
  constructor(expected, actual) {
    super(`Memory revision conflict: expected ${expected}, actual ${actual}`);
    this.name = 'MemoryRevisionConflictError';
  }
}

/** @param {import('better-sqlite3').Database} db @param {string} resourceId
 * @returns {import('./memory-types.js').MemorySnapshot} */
function snapshot(db, resourceId) {
  const revision = Number(
    db
      .prepare('SELECT revision FROM brainstrike_memory_scopes WHERE resource_id=?')
      .pluck()
      .get(resourceId) ?? 0
  );
  const rows =
    /** @type {Array<{kind:import('./memory-types.js').MemoryEntityKind,id:string,thread_id:string|null,payload:string}>} */ (
      db
        .prepare(
          'SELECT kind,id,thread_id,payload FROM brainstrike_memory_entities WHERE resource_id=? ORDER BY kind,rowid'
        )
        .all(resourceId)
    );
  return {
    entities: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      threadId: row.thread_id,
    })),
    revision,
  };
}

/** @param {unknown} value @param {string} label */
function id(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Invalid memory ${label}`);
  }
}

/** BST-1929 composed deletion: resource-only native tails must not recreate
 * erased WM/OM after their canonical thread was deleted.
 * @param {import('better-sqlite3').Database} db @param {string | undefined} threadId */
function assertOwnerThread(db, threadId) {
  if (threadId !== undefined && !db.prepare('SELECT 1 FROM threads WHERE id=?').get(threadId)) {
    throw new Error('Memory owner thread has been retired');
  }
}

/** @param {import('better-sqlite3').Database} db @param {string} resourceId
 * @param {import('./memory-types.js').MemoryEntity} value */
function putEntity(db, resourceId, value) {
  if (value.payload['id'] !== value.id) {
    throw new Error('Memory entity ID does not match its payload');
  }
  if (value.kind === 'resource' && value.id !== resourceId) {
    throw new Error('Memory resource identity changed');
  }
  if (value.kind !== 'resource' && value.payload['resourceId'] !== resourceId) {
    throw new Error('Memory entity crossed its resource owner');
  }
  if (value.kind === 'thread' && value.threadId !== value.id) {
    throw new Error('Memory thread identity changed');
  }
  if (value.kind === 'observation' && (value.payload['threadId'] ?? null) !== value.threadId) {
    throw new Error('Memory observation thread identity changed');
  }
  const old = db
    .prepare('SELECT resource_id FROM brainstrike_memory_entities WHERE kind=? AND id=?')
    .pluck()
    .get(value.kind, value.id);
  if (old !== undefined && old !== resourceId) {
    throw new Error('Memory entity belongs to another resource');
  }
  db.prepare(
    'INSERT INTO brainstrike_memory_entities(kind,id,resource_id,thread_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,thread_id=excluded.thread_id'
  ).run(value.kind, value.id, resourceId, value.threadId, JSON.stringify(value.payload));
}

/** @param {import('better-sqlite3').Database} db @param {string} resourceId
 * @param {import('./memory-types.js').MemoryEntityChange} change */
function applyChange(db, resourceId, change) {
  const entity = change.operation === 'put' ? change.entity : change;
  id(entity.id, 'entity ID');
  if (!['thread', 'resource', 'observation'].includes(entity.kind)) {
    throw new TypeError('Invalid memory entity kind');
  }
  if (change.operation === 'remove') {
    db.prepare(
      'DELETE FROM brainstrike_memory_entities WHERE kind=? AND id=? AND resource_id=?'
    ).run(change.kind, change.id, resourceId);
  } else {
    putEntity(db, resourceId, change.entity);
  }
}

/** @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./memory-types.js').MemoryDomainRequest,{operation:'purge-thread'}>} request */
function purgeThread(db, request) {
  id(request.threadId, 'thread ID');
  db.prepare('DELETE FROM brainstrike_memory_entities WHERE resource_id=? AND thread_id=?').run(
    request.resourceId,
    request.threadId
  );
  if (request.sharedResource === 'clear') {
    // A native shared OM/working-memory record cannot be partially un-observed.
    // The host purge owner explicitly chooses this erasure or fails closed.
    db.prepare(
      'DELETE FROM brainstrike_memory_entities WHERE resource_id=? AND thread_id IS NULL'
    ).run(request.resourceId);
  } else if (request.sharedResource !== 'preserve') {
    throw new TypeError('Invalid shared memory purge policy');
  }
}

/**
 * A native public operation is calculated on an isolated vendor projection.
 * Its complete delta commits iff the writer snapshot remains current. A
 * conflict fails visibly: no automatic retry, merge guess or partial write.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./memory-types.js').MemoryDomainRequest} request
 * @returns {import('./memory-types.js').MemorySnapshot}
 */
export function executeMemoryRequest(db, request) {
  id(request.resourceId, 'resource ID');
  return db.transaction(() => {
    assertOwnerThread(db, request.ownerThreadId);
    if (request.operation === 'read') {
      return snapshot(db, request.resourceId);
    }
    db.prepare(
      'INSERT INTO brainstrike_memory_scopes(resource_id,revision) VALUES(?,0) ON CONFLICT(resource_id) DO NOTHING'
    ).run(request.resourceId);
    const current = snapshot(db, request.resourceId);
    if (request.operation === 'commit') {
      if (!(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0)) {
        throw new TypeError('Invalid memory revision');
      }
      if (current.revision !== request.expectedRevision) {
        throw new MemoryRevisionConflictError(request.expectedRevision, current.revision);
      }
      for (const change of request.changes) {
        applyChange(db, request.resourceId, change);
      }
    } else if (request.operation === 'purge-resource') {
      db.prepare('DELETE FROM brainstrike_memory_entities WHERE resource_id=?').run(
        request.resourceId
      );
    } else if (request.operation === 'purge-thread') {
      purgeThread(db, request);
    } else {
      throw new TypeError('Unknown memory operation');
    }
    db.prepare('UPDATE brainstrike_memory_scopes SET revision=revision+1 WHERE resource_id=?').run(
      request.resourceId
    );
    return snapshot(db, request.resourceId);
  })();
}

/**
 * Studio invokes this while holding the existing StateStore mutation chain.
 * Read-only operations may see the previous committed snapshot while the pure
 * vendor calculator runs; every mutation remains serialized by the one owner.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./memory-types.js').MemoryNativeRequest} request
 * @param {import('./memory-types.js').MemoryNativeCalculator} calculate
 * @returns {Promise<import('./memory-types.js').MemorySnapshot>}
 */
export async function executeNativeMemoryRequest(db, request, calculate) {
  id(request.resourceId, 'resource ID');
  assertOwnerThread(db, request.ownerThreadId);
  const current = snapshot(db, request.resourceId);
  const result = await calculate(current, request);
  const committed =
    result.changes.length === 0
      ? current
      : executeMemoryRequest(db, {
          changes: result.changes,
          expectedRevision: current.revision,
          operation: 'commit',
          resourceId: request.resourceId,
          ...(request.ownerThreadId === undefined ? {} : { ownerThreadId: request.ownerThreadId }),
        });
  return { ...committed, value: result.value };
}
