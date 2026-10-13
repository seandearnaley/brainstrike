// @ts-check
import { createHash, randomUUID } from 'node:crypto';

export const SOURCE_CATALOG_SCHEMA = `
CREATE TABLE file_records (
  id TEXT PRIMARY KEY NOT NULL,
  root_id TEXT REFERENCES roots(id) ON DELETE CASCADE,
  embedding_set_id TEXT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ms REAL,
  size INTEGER NOT NULL CHECK (size >= 0),
  chunks_count INTEGER CHECK (chunks_count >= 0),
  chunks_processed INTEGER NOT NULL DEFAULT 0 CHECK (chunks_processed IN (0,1))
) STRICT;
CREATE UNIQUE INDEX file_records_managed_identity ON file_records
  (root_id, COALESCE(embedding_set_id, ''), path) WHERE root_id IS NOT NULL;
CREATE INDEX file_records_collection ON file_records(embedding_set_id);
CREATE TABLE source_blob_gc (hash TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE TRIGGER file_source_replaced AFTER UPDATE OF content_hash ON file_records
WHEN old.content_hash <> new.content_hash BEGIN
  INSERT OR IGNORE INTO source_blob_gc(hash) VALUES (old.content_hash);
END;
CREATE TRIGGER file_source_removed AFTER DELETE ON file_records BEGIN
  INSERT OR IGNORE INTO source_blob_gc(hash) VALUES (old.content_hash);
END;
`;
const projection = `id AS fileId, root_id AS rootId, embedding_set_id AS embeddingSetId,
  path, name AS fileName, created_at AS createdAt, updated_at AS updatedAt, chunks_count AS chunksCount, content_hash AS contentHash, mtime_ms AS mtimeMs, size,
  chunks_processed AS chunksProcessed`;

/** @typedef {import('./source-catalog-types.js').SourceCatalogRecord} Record */
/** @typedef {import('./source-catalog-types.js').SourceCatalogInput} Input */
/** @typedef {Omit<Record, 'content' | 'stat' | 'chunksProcessed'> & { mtimeMs:number|null; size:number; chunksProcessed:0|1 }} Row */
/** @typedef {{put(hash:string,content:string):void;read(hash:string,maxBytes:number):string|null}} Blobs */

/** @param {Row} row @returns {Record} */
function record(row) {
  const { mtimeMs, size, chunksProcessed, ...fields } = row;
  return {
    ...fields,
    chunksProcessed: chunksProcessed === 1,
    content: null,
    stat: { mtimeMs, size },
  };
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {Record} */
function read(db, id) {
  const row = /** @type {Row | undefined} */ (
    db.prepare(`SELECT ${projection} FROM file_records WHERE id=?`).get(id)
  );
  if (!row) {
    throw new Error('Canonical source identity is missing');
  }
  return record(row);
}
/** @param {Input} source */
function assertSource(source) {
  if (
    !(source.fileName.trim() && source.path.trim()) ||
    source.content.includes('\0') ||
    !Number.isSafeInteger(source.stat.size) ||
    source.stat.size < 0 ||
    (source.stat.mtimeMs !== null &&
      (!Number.isFinite(source.stat.mtimeMs) || source.stat.mtimeMs < 0)) ||
    createHash('sha256').update(source.content).digest('hex') !== source.contentHash
  ) {
    throw new Error('Canonical source metadata or content hash is invalid');
  }
}
/** @param {readonly unknown[]} files */
function assertBatch(files) {
  if (files.length > 250) {
    throw new Error('Canonical catalog batch exceeds 250 files');
  }
}
/** @param {import('better-sqlite3').Database} db @param {readonly Record[]} expected */
function assertExpected(db, expected) {
  assertBatch(expected);
  if (new Set(expected.map((file) => file.fileId)).size !== expected.length) {
    throw new Error('Canonical catalog batch contains duplicate identities');
  }
  for (const file of expected) {
    const current = read(db, file.fileId);
    if (
      current.contentHash !== file.contentHash ||
      current.rootId !== file.rootId ||
      current.embeddingSetId !== file.embeddingSetId ||
      current.path !== file.path ||
      current.fileName !== file.fileName
    ) {
      throw new Error('Canonical mutation rejected stale source metadata');
    }
  }
}
/** @param {import('better-sqlite3').Database} db @param {string} id @param {Input} source */
function replace(db, id, source) {
  db.prepare(`UPDATE file_records SET content_hash=?, mtime_ms=?, size=?, updated_at=?,
    chunks_processed=CASE WHEN content_hash=? THEN chunks_processed ELSE 0 END,
    chunks_count=CASE WHEN content_hash=? THEN chunks_count ELSE NULL END WHERE id=?`).run(
    source.contentHash,
    source.stat.mtimeMs,
    source.stat.size,
    new Date().toISOString(),
    source.contentHash,
    source.contentHash,
    id
  );
}
/** @param {import('better-sqlite3').Database} db @param {string|null} id */
function assertCollection(db, id) {
  if (id !== null && !db.prepare('SELECT id FROM embedding_sets WHERE id=?').get(id)) {
    throw new Error('Canonical source collection does not exist');
  }
}
/** Imported source identity follows the existing content-hash + collection deduplication rule.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest & {operation:'import'}} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.js').SourceCatalogReply} */
function importSources(db, request, blobs) {
  assertBatch(request.files);
  assertCollection(db, request.embeddingSetId);
  for (const source of request.files) {
    assertSource(source);
  }
  /** @type {boolean[]} */
  const imported = [];
  const files = request.files.map((source) => {
    const existing = /** @type {{id:string}|undefined} */ (
      db
        .prepare(
          'SELECT id FROM file_records WHERE root_id IS NULL AND content_hash=? AND embedding_set_id IS ? ORDER BY id LIMIT 1'
        )
        .get(source.contentHash, request.embeddingSetId)
    );
    imported.push(!existing);
    if (existing) {
      return read(db, existing.id);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    blobs.put(source.contentHash, source.content);
    db.prepare(
      'INSERT INTO file_records(id,root_id,embedding_set_id,path,name,content_hash,mtime_ms,size,created_at,updated_at) VALUES (?,NULL,?,?,?,?,?,?,?,?)'
    ).run(
      id,
      request.embeddingSetId,
      source.path,
      source.fileName,
      source.contentHash,
      source.stat.mtimeMs,
      source.stat.size,
      now,
      now
    );
    return read(db, id);
  });
  return { files, imported };
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest & {operation:'prepare'}} request
 * @param {Blobs} blobs @returns {Record[]} */
function prepare(db, request, blobs) {
  assertBatch(request.files);
  assertCollection(db, request.embeddingSetId);
  if (!db.prepare("SELECT id FROM roots WHERE id=? AND status='live'").get(request.rootId)) {
    throw new Error('Canonical discovery root is absent or revoked');
  }
  if (new Set(request.files.map((file) => file.path)).size !== request.files.length) {
    throw new Error('Canonical discovery contains duplicate source paths');
  }
  for (const source of request.files) {
    assertSource(source);
  }
  return request.files.map((source) => {
    const existing = /** @type {{id:string}|undefined} */ (
      db
        .prepare('SELECT id FROM file_records WHERE root_id=? AND embedding_set_id IS ? AND path=?')
        .get(request.rootId, request.embeddingSetId, source.path)
    );
    const id = existing?.id ?? randomUUID();
    blobs.put(source.contentHash, source.content);
    if (existing) {
      replace(db, id, source);
    } else {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO file_records (id,root_id,embedding_set_id,path,name,content_hash,mtime_ms,size,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id,
        request.rootId,
        request.embeddingSetId,
        source.path,
        source.fileName,
        source.contentHash,
        source.stat.mtimeMs,
        source.stat.size,
        now,
        now
      );
    }
    return read(db, id);
  });
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest & {operation:'read'}} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.js').SourceCatalogReply} */
function readSources(db, request, blobs) {
  assertBatch(request.fileIds);
  const max = request.maxContentBytes;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
    throw new Error('Canonical source read requires a nonnegative byte bound');
  }
  return {
    files: request.fileIds.map((id) => {
      const current = read(db, id);
      return max === undefined
        ? current
        : { ...current, content: blobs.read(current.contentHash, max) };
    }),
  };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest & {operation:'replace'}} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.js').SourceCatalogReply} */
function replaceSources(db, request, blobs) {
  assertExpected(
    db,
    request.files.map((file) => file.expected)
  );
  for (const { expected, source } of request.files) {
    assertSource(source);
    if (
      expected.path !== source.path ||
      expected.fileName !== source.fileName ||
      (expected.rootId === null && expected.contentHash !== source.contentHash)
    ) {
      throw new Error('Canonical source replacement changes its retained identity');
    }
  }
  for (const { expected, source } of request.files) {
    blobs.put(source.contentHash, source.content);
    replace(db, expected.fileId, source);
  }
  return { files: request.files.map((file) => read(db, file.expected.fileId)) };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest & {operation:'complete'}} request
 * @returns {import('./source-catalog-types.js').SourceCatalogReply} */
function completeSources(db, request) {
  assertExpected(
    db,
    request.files.map((file) => file.expected)
  );
  for (const { expected, chunkCount } of request.files) {
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) {
      throw new Error('Canonical completion requires a nonnegative chunk count');
    }
    db.prepare('UPDATE file_records SET chunks_count=?,chunks_processed=1 WHERE id=?').run(
      chunkCount,
      expected.fileId
    );
  }
  return { files: request.files.map((file) => read(db, file.expected.fileId)) };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.js').SourceCatalogRequest} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.js').SourceCatalogReply} */
export function executeSourceCatalogRequest(db, request, blobs) {
  return db.transaction(() => {
    switch (request.operation) {
      case 'list':
        return {
          files: /** @type {Row[]} */ (
            db.prepare(`SELECT ${projection} FROM file_records ORDER BY created_at DESC,id`).all()
          ).map(record),
        };
      case 'inventory':
        return {
          files: /** @type {Row[]} */ (
            db
              .prepare(
                `SELECT ${projection} FROM file_records WHERE embedding_set_id IS ? ORDER BY id`
              )
              .all(request.embeddingSetId)
          ).map(record),
        };
      case 'read':
        return readSources(db, request, blobs);
      case 'import':
        return importSources(db, request, blobs);
      case 'prepare':
        return { files: prepare(db, request, blobs) };
      case 'replace':
        return replaceSources(db, request, blobs);
      case 'complete':
        return completeSources(db, request);
      case 'remove':
        assertExpected(db, request.files);
        for (const file of request.files) {
          db.prepare('DELETE FROM file_records WHERE id=?').run(file.fileId);
        }
        return { files: request.files };
      default:
        throw new Error('Unknown canonical source operation');
    }
  })();
}
