// @ts-check
import { createHash } from 'node:crypto';

const projection = `id AS fileId, root_id AS rootId, embedding_set_id AS embeddingSetId,
  path, name AS fileName, created_at AS createdAt, updated_at AS updatedAt, chunks_count AS chunksCount, content_hash AS contentHash, mtime_ms AS mtimeMs, size,
  chunks_processed AS chunksProcessed`;

/** @typedef {import('./source-catalog-types.ts').SourceCatalogRecord} Record */
/** @typedef {import('./source-catalog-types.ts').SourceCatalogInput} Input */
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
// better-sqlite3 does not cache prepared statements: each request prepares a statement once,
// never per row.
/** @param {import('better-sqlite3').Database} db @returns {(id: string) => Record} */
function reader(db) {
  const select = db.prepare(`SELECT ${projection} FROM file_records WHERE id=?`);
  return (id) => {
    const row = /** @type {Row | undefined} */ (select.get(id));
    if (!row) {
      throw new Error('Canonical source identity is missing');
    }
    return record(row);
  };
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
/** @param {(id: string) => Record} read @param {readonly Record[]} expected */
function assertExpected(read, expected) {
  assertBatch(expected);
  if (new Set(expected.map((file) => file.fileId)).size !== expected.length) {
    throw new Error('Canonical catalog batch contains duplicate identities');
  }
  for (const file of expected) {
    const current = read(file.fileId);
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
/** @param {import('better-sqlite3').Database} db @returns {(id: string, source: Input) => void} */
function replacer(db) {
  const update =
    db.prepare(`UPDATE file_records SET content_hash=?, mtime_ms=?, size=?, updated_at=?,
    chunks_processed=CASE WHEN content_hash=? THEN chunks_processed ELSE 0 END,
    chunks_count=CASE WHEN content_hash=? THEN chunks_count ELSE NULL END WHERE id=?`);
  return (id, source) => {
    update.run(
      source.contentHash,
      source.stat.mtimeMs,
      source.stat.size,
      new Date().toISOString(),
      source.contentHash,
      source.contentHash,
      id
    );
  };
}
/** @param {import('better-sqlite3').Database} db @param {string|null} id */
function assertCollection(db, id) {
  if (id !== null && !db.prepare('SELECT id FROM embedding_sets WHERE id=?').get(id)) {
    throw new Error('Canonical source collection does not exist');
  }
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.ts').SourceCatalogRequest & {operation:'prepare'}} request
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
  const read = reader(db);
  const replace = replacer(db);
  const select = db.prepare(
    'SELECT id FROM file_records WHERE root_id=? AND embedding_set_id IS ? AND path=?'
  );
  const insert =
    db.prepare(`INSERT INTO file_records (id,root_id,embedding_set_id,path,name,content_hash,mtime_ms,size,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
  return request.files.map((source) => {
    const existing = /** @type {{id:string}|undefined} */ (
      select.get(request.rootId, request.embeddingSetId, source.path)
    );
    const id = existing?.id ?? crypto.randomUUID();
    blobs.put(source.contentHash, source.content);
    if (existing) {
      replace(id, source);
    } else {
      const now = new Date().toISOString();
      insert.run(
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
    return read(id);
  });
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.ts').SourceCatalogRequest & {operation:'read'}} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.ts').SourceCatalogReply} */
function readSources(db, request, blobs) {
  assertBatch(request.fileIds);
  const max = request.maxContentBytes;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
    throw new Error('Canonical source read requires a nonnegative byte bound');
  }
  const read = reader(db);
  return {
    files: request.fileIds.map((id) => {
      const current = read(id);
      return max === undefined
        ? current
        : { ...current, content: blobs.read(current.contentHash, max) };
    }),
  };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.ts').SourceCatalogRequest & {operation:'replace'}} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.ts').SourceCatalogReply} */
function replaceSources(db, request, blobs) {
  const read = reader(db);
  assertExpected(
    read,
    request.files.map((file) => file.expected)
  );
  for (const { expected, source } of request.files) {
    assertSource(source);
    if (expected.path !== source.path || expected.fileName !== source.fileName) {
      throw new Error('Canonical source replacement changes its retained identity');
    }
  }
  const replace = replacer(db);
  for (const { expected, source } of request.files) {
    blobs.put(source.contentHash, source.content);
    replace(expected.fileId, source);
  }
  return { files: request.files.map((file) => read(file.expected.fileId)) };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.ts').SourceCatalogRequest & {operation:'complete'}} request
 * @returns {import('./source-catalog-types.ts').SourceCatalogReply} */
function completeSources(db, request) {
  const read = reader(db);
  assertExpected(
    read,
    request.files.map((file) => file.expected)
  );
  const update = db.prepare('UPDATE file_records SET chunks_count=?,chunks_processed=1 WHERE id=?');
  for (const { expected, chunkCount } of request.files) {
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) {
      throw new Error('Canonical completion requires a nonnegative chunk count');
    }
    update.run(chunkCount, expected.fileId);
  }
  return { files: request.files.map((file) => read(file.expected.fileId)) };
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./source-catalog-types.ts').SourceCatalogRequest} request
 * @param {Blobs} blobs @returns {import('./source-catalog-types.ts').SourceCatalogReply} */
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
      case 'prepare':
        return { files: prepare(db, request, blobs) };
      case 'replace':
        return replaceSources(db, request, blobs);
      case 'complete':
        return completeSources(db, request);
      case 'remove': {
        assertExpected(reader(db), request.files);
        const remove = db.prepare('DELETE FROM file_records WHERE id=?');
        for (const file of request.files) {
          remove.run(file.fileId);
        }
        return { files: request.files };
      }
      default:
        throw new Error('Unknown canonical source operation');
    }
  })();
}
