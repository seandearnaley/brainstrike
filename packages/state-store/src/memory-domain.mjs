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

const THREAD_SECTION = /<thread id="([^"]+)">[\s\S]*?<\/thread>/gu;

/**
 * Mastra Memory 1.32.1 persists resource-scope observations as
 * `<thread id="...">` sections joined by separators (ObservationStrategy
 * wrapWithThreadTag/replaceOrAppendThreadSection); it exposes no public way to
 * remove one thread's section. Drop that thread's sections, each with the
 * separator before it (after it, for the first), and keep the rest unchanged.
 * Returns the kept [start, end) ranges of `text` in order, or null when no
 * section is the thread's. Known limit: with OM `obscureThreadIds` the tag
 * holds a hash, not the thread ID, so such sections stay; nothing enables it.
 * Remove when Memory offers a public resource-attribution editor.
 * https://github.com/mastra-ai/mastra/tree/@mastra/memory@1.32.1/packages/memory
 * @param {string} text @param {string} threadId
 * @returns {{ start: number; end: number }[] | null} */
function keptRanges(text, threadId) {
  const sections = [...text.matchAll(THREAD_SECTION)].map((match) => ({
    end: match.index + match[0].length,
    owner: match[1],
    start: match.index,
  }));
  if (sections.every((section) => section.owner !== threadId)) {
    return null;
  }
  const kept = [];
  let previousEnd = 0;
  for (const section of sections) {
    if (section.owner !== threadId) {
      kept.push({ end: section.end, start: kept.length === 0 ? section.start : previousEnd });
    }
    previousEnd = section.end;
  }
  if (kept.length === 0) {
    return [];
  }
  const lead = { end: sections[0]?.start ?? 0, start: 0 };
  return [lead, ...kept, { end: text.length, start: previousEnd }];
}

/** @param {string} text @param {{ start: number; end: number }[]} ranges */
function joinRanges(text, ranges) {
  return ranges.map(({ end, start }) => text.slice(start, end)).join('');
}

/**
 * Mastra activates a buffered reflection over the first
 * `reflectedObservationLineCount` lines of the active observations. Count the
 * lines of the detached text that hold what is left of that prefix.
 * @param {string} before @param {string} after
 * @param {{ start: number; end: number }[]} ranges @param {number} lines */
function reflectedLinesAfter(before, after, ranges, lines) {
  const prefix = before.split('\n').slice(0, lines).join('\n').length;
  const left = ranges.reduce(
    (sum, { end, start }) => sum + Math.max(0, Math.min(end, prefix) - start),
    0
  );
  return left === 0 ? 0 : after.slice(0, left - 1).split('\n').length;
}

/**
 * `key`'s text without the thread's sections, written to `detached`; null when
 * none are its.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} key @param {string} threadId
 * @returns {string | null} */
function detachField(record, detached, key, threadId) {
  const text = record[key];
  const ranges = typeof text === 'string' ? keptRanges(text, threadId) : null;
  if (!(typeof text === 'string' && ranges)) {
    return null;
  }
  const after = joinRanges(text, ranges);
  detached[key] = after;
  return after;
}

/**
 * The active observations and their counters. `bufferedReflectionInputTokens`
 * is Mastra's own slice estimate (doAsyncBufferedReflection): the record's
 * tokens per active line, times the reflected lines.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.js').ObservationTokenCounter} count */
function detachActive(record, detached, threadId, count) {
  const active = record['activeObservations'];
  const ranges = typeof active === 'string' ? keptRanges(active, threadId) : null;
  if (!(typeof active === 'string' && ranges)) {
    return false;
  }
  const after = joinRanges(active, ranges);
  const tokens = count(after);
  detached['activeObservations'] = after;
  detached['observationTokenCount'] = tokens;
  const lines = record['reflectedObservationLineCount'];
  if (typeof lines !== 'number') {
    return true;
  }
  const reflected = reflectedLinesAfter(active, after, ranges, lines);
  detached['reflectedObservationLineCount'] = reflected;
  if (typeof record['bufferedReflectionInputTokens'] === 'number') {
    detached['bufferedReflectionInputTokens'] = Math.round(
      (tokens / after.split('\n').length) * reflected
    );
  }
  return true;
}

/**
 * The buffered reflection and its tokens. One left empty is cleared with its
 * counters, as Mastra's swapBufferedReflectionToActive clears an activated
 * one, so its lines stay active and unreflected.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.js').ObservationTokenCounter} count */
function detachReflection(record, detached, threadId, count) {
  const reflection = detachField(record, detached, 'bufferedReflection', threadId);
  if (reflection === null) {
    return false;
  }
  if (reflection !== '') {
    detached['bufferedReflectionTokens'] = count(reflection);
    return true;
  }
  for (const key of [
    'bufferedReflection',
    'bufferedReflectionTokens',
    'bufferedReflectionInputTokens',
    'reflectedObservationLineCount',
  ]) {
    delete detached[key];
  }
  return true;
}

/**
 * The buffered chunks and each changed chunk's tokens.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.js').ObservationTokenCounter} count */
function detachChunks(record, detached, threadId, count) {
  const chunks = record['bufferedObservationChunks'];
  if (!Array.isArray(chunks)) {
    return false;
  }
  let changed = false;
  detached['bufferedObservationChunks'] = chunks.flatMap(
    /** @param {Record<string, unknown>} chunk */ (chunk) => {
      const text = chunk['observations'];
      const ranges = typeof text === 'string' ? keptRanges(text, threadId) : null;
      if (!(typeof text === 'string' && ranges)) {
        return [chunk];
      }
      changed = true;
      // A buffered chunk that held only the deleted thread has nothing left to activate.
      if (ranges.length === 0) {
        return [];
      }
      const observations = joinRanges(text, ranges);
      return [{ ...chunk, observations, tokenCount: count(observations) }];
    }
  );
  return changed;
}

/**
 * One shared observation record without `threadId`'s sections, or null when
 * none are its. Each changed text's token field is recounted with Mastra OM's
 * own counter, the one that set it; untouched texts keep their stored counts.
 * @param {Record<string, unknown>} record @param {string} threadId
 * @param {import('./memory-types.js').ObservationTokenCounter | undefined} countTokens
 * @returns {Record<string, unknown> | null} */
function detachRecord(record, threadId, countTokens) {
  /** @param {string} text */
  const count = (text) => {
    if (!countTokens) {
      throw new Error('Detaching thread observations requires the observation token counter');
    }
    return countTokens(text);
  };
  const detached = { ...record };
  // In order: a reflection left empty clears the line count the active pass set.
  const changed = [
    detachActive(record, detached, threadId, count),
    detachField(record, detached, 'bufferedObservations', threadId) !== null,
    detachReflection(record, detached, threadId, count),
    detachChunks(record, detached, threadId, count),
  ];
  return changed.includes(true) ? detached : null;
}

/** @param {import('better-sqlite3').Database} db @param {string} resourceId @param {string} threadId
 * @param {import('./memory-types.js').ObservationTokenCounter | undefined} countTokens */
function detachThreadObservations(db, resourceId, threadId, countTokens) {
  const rows = /** @type {{ id: string; payload: string }[]} */ (
    db
      .prepare(
        "SELECT id, payload FROM brainstrike_memory_entities WHERE resource_id=? AND thread_id IS NULL AND kind='observation'"
      )
      .all(resourceId)
  );
  for (const row of rows) {
    const detached = detachRecord(JSON.parse(row.payload), threadId, countTokens);
    if (detached) {
      db.prepare('UPDATE brainstrike_memory_entities SET payload=? WHERE kind=? AND id=?').run(
        JSON.stringify(detached),
        'observation',
        row.id
      );
    }
  }
}

/** @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./memory-types.js').MemoryDomainRequest,{operation:'purge-thread'}>} request
 * @param {import('./memory-types.js').ObservationTokenCounter | undefined} countTokens */
function purgeThread(db, request, countTokens) {
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
  } else if (request.sharedResource === 'detach-thread') {
    // Legacy kept shared resource memory when a thread was deleted. Working
    // memory stays as it is; a shared observation record loses only the
    // deleted thread's attributed sections, so every other thread's stay.
    detachThreadObservations(db, request.resourceId, request.threadId, countTokens);
  } else if (request.sharedResource !== 'preserve') {
    throw new TypeError('Invalid shared memory purge policy');
  }
}

/**
 * A native public operation is calculated on an isolated vendor projection.
 * Its complete delta commits iff the writer snapshot remains current. A
 * conflict fails visibly: no automatic retry, merge guess or partial write.
 * `countTokens` is Mastra OM's observation token counter, which a
 * `detach-thread` purge needs to recount the shared records it changes.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./memory-types.js').MemoryDomainRequest} request
 * @param {import('./memory-types.js').ObservationTokenCounter} [countTokens]
 * @returns {import('./memory-types.js').MemorySnapshot}
 */
export function executeMemoryRequest(db, request, countTokens) {
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
      purgeThread(db, request, countTokens);
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
