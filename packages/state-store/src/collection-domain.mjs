// @ts-check
export const COLLECTION_SCHEMA = `
CREATE TABLE embedding_sets (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
  model_key TEXT NOT NULL CHECK(length(model_key)>0),
  model_id TEXT NOT NULL CHECK(length(model_id)>0),
  dimensions INTEGER NOT NULL CHECK(dimensions>0 AND dimensions<=16000),
  distance TEXT NOT NULL CHECK(distance IN ('cosine','l2','ip')),
  created_at TEXT NOT NULL,
  name TEXT,
  description TEXT,
  category TEXT,
  tags TEXT,
  system_role TEXT CHECK(system_role IS NULL OR system_role='workspace-index')
) STRICT;
CREATE UNIQUE INDEX embedding_sets_system_role ON embedding_sets(system_role) WHERE system_role IS NOT NULL;
`;
const projection =
  'id,model_key AS modelKey,model_id AS modelId,dimensions,distance,created_at AS createdAt,name,description,category,tags,system_role AS systemRole';
/** @typedef {import('./collection-types.js').CollectionRecord} Collection */
/** @typedef {Omit<Collection, 'name'|'description'|'category'|'tags'|'systemRole'> & {name:string|null;description:string|null;category:string|null;tags:string|null;systemRole:'workspace-index'|null}} Row */
/** @param {Row} row @returns {Collection} */
function record(row) {
  const { name, description, category, tags, systemRole, ...required } = row;
  return {
    ...required,
    ...(name === null ? {} : { name }),
    ...(description === null ? {} : { description }),
    ...(category === null ? {} : { category }),
    ...(tags === null ? {} : { tags }),
    ...(systemRole === null ? {} : { systemRole }),
  };
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {Collection[]} */
function read(db, id) {
  const row = /** @type {Row|undefined} */ (
    db.prepare(`SELECT ${projection} FROM embedding_sets WHERE id=?`).get(id)
  );
  return row ? [record(row)] : [];
}
/** @param {Collection} collection */
function validate(collection) {
  const separator = collection.modelKey.indexOf('::');
  if (
    !collection.id.trim() ||
    separator <= 0 ||
    collection.modelKey.slice(separator + 2) !== collection.modelId ||
    !collection.modelId.trim() ||
    !Number.isSafeInteger(collection.dimensions) ||
    collection.dimensions <= 0 ||
    !Number.isFinite(Date.parse(collection.createdAt))
  ) {
    throw new Error('Collection identity or selected model profile is invalid');
  }
}
/** @param {import('better-sqlite3').Database} db @param {Collection} collection @returns {Collection[]} */
function create(db, collection) {
  validate(collection);
  if (collection.systemRole) {
    const existing = /** @type {Row|undefined} */ (
      db
        .prepare(`SELECT ${projection} FROM embedding_sets WHERE system_role=?`)
        .get(collection.systemRole)
    );
    if (existing) {
      return [record(existing)];
    }
  }
  db.prepare(
    'INSERT INTO embedding_sets(id,model_key,model_id,dimensions,distance,created_at,name,description,category,tags,system_role) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    collection.id,
    collection.modelKey,
    collection.modelId,
    collection.dimensions,
    collection.distance,
    collection.createdAt,
    collection.name ?? null,
    collection.description ?? null,
    collection.category ?? null,
    collection.tags ?? null,
    collection.systemRole ?? null
  );
  return read(db, collection.id);
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./collection-types.js').CollectionRequest} request
 * @returns {import('./collection-types.js').CollectionReply} */
export function executeCollectionRequest(db, request) {
  return db.transaction(() => {
    switch (request.operation) {
      case 'snapshot':
        return {
          collections: /** @type {Row[]} */ (
            db.prepare(`SELECT ${projection} FROM embedding_sets ORDER BY created_at DESC,id`).all()
          ).map(record),
          counts:
            /** @type {NonNullable<import('./collection-types.js').CollectionReply['counts']>} */ (
              db
                .prepare(
                  'SELECT s.id, COUNT(f.id) AS files, COALESCE(SUM(f.chunks_count),0) AS chunks, SUM(CASE WHEN f.id IS NOT NULL AND f.chunks_processed=0 THEN 1 ELSE 0 END) AS unprocessedFiles FROM embedding_sets s LEFT JOIN file_records f ON f.embedding_set_id=s.id GROUP BY s.id ORDER BY s.created_at DESC,s.id'
                )
                .all()
            ),
        };
      case 'list':
        return {
          collections: /** @type {Row[]} */ (
            db.prepare(`SELECT ${projection} FROM embedding_sets ORDER BY created_at DESC,id`).all()
          ).map(record),
        };
      case 'get':
        return { collections: read(db, request.id) };
      case 'create':
        return { collections: create(db, request.collection) };
      case 'update': {
        const metadata = request.metadata;
        db.prepare(
          'UPDATE embedding_sets SET name=COALESCE(?,name),description=COALESCE(?,description),category=COALESCE(?,category),tags=COALESCE(?,tags) WHERE id=?'
        ).run(
          metadata.name ?? null,
          metadata.description ?? null,
          metadata.category ?? null,
          metadata.tags ?? null,
          request.id
        );
        return { collections: read(db, request.id) };
      }
      case 'delete': {
        const collections = read(db, request.id);
        db.prepare('DELETE FROM embedding_sets WHERE id=?').run(request.id);
        return { collections };
      }
      default:
        throw new Error('Unknown collection operation');
    }
  })();
}
