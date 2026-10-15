// @ts-check
import { derivePromptItemTitle, normalizePromptItemTags } from '@brainstrike/types/prompt-item';

export const PROMPT_CATALOG_SCHEMA = `
CREATE TABLE prompt_items (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
 kind TEXT NOT NULL CHECK(kind IN ('prompt','snippet','fragment')),
 title TEXT NOT NULL CHECK(length(trim(title))>0),
 content TEXT NOT NULL CHECK(length(trim(content))>0),
 description TEXT, tags TEXT NOT NULL CHECK(json_valid(tags) AND json_type(tags)='array'),
 is_favorite INTEGER NOT NULL CHECK(is_favorite IN (0,1)), archived_at TEXT, source_url TEXT,
 rating INTEGER CHECK(rating IS NULL OR rating BETWEEN 0 AND 5), model_key TEXT,
 model_settings TEXT CHECK(model_settings IS NULL OR (json_valid(model_settings) AND json_type(model_settings)='object')),
 revision INTEGER NOT NULL CHECK(revision>0), use_count INTEGER NOT NULL CHECK(use_count>=0),
 last_used_at TEXT,last_used_action TEXT CHECK(last_used_action IS NULL OR last_used_action IN ('compose','insert','new-thread')),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE prompt_item_revisions (
 id TEXT PRIMARY KEY NOT NULL,prompt_item_id TEXT NOT NULL REFERENCES prompt_items(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0),title TEXT NOT NULL,content TEXT NOT NULL,description TEXT,
 tags TEXT NOT NULL CHECK(json_valid(tags) AND json_type(tags)='array'),model_key TEXT,model_settings TEXT,
 note TEXT,created_at TEXT NOT NULL,UNIQUE(prompt_item_id,revision)
) STRICT;
CREATE INDEX prompt_items_updated ON prompt_items(is_favorite DESC,updated_at DESC,id);
CREATE INDEX prompt_item_revisions_item ON prompt_item_revisions(prompt_item_id,revision DESC);
`;
const columns = `id,kind,title,content,description,tags,is_favorite AS isFavorite,archived_at AS archivedAt,
source_url AS sourceUrl,rating,model_key AS modelKey,model_settings AS modelSettings,revision,
use_count AS useCount,last_used_at AS lastUsedAt,last_used_action AS lastUsedAction,
created_at AS createdAt,updated_at AS updatedAt`;
/** @typedef {import('./prompt-catalog-types.js').PromptCatalogRecord} Item */
/** @typedef {Omit<Item,'tags'|'modelSettings'|'isFavorite'> & {tags:string;modelSettings:string|null;isFavorite:0|1}} Row */
/** @param {string} value @returns {string[]} */
function tags(value) {
  const parsed = /** @type {unknown} */ (JSON.parse(value));
  if (!(Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'))) {
    throw new Error('Prompt tags are invalid');
  }
  return parsed;
}
/** @param {string|null} value @returns {Record<string,unknown>|null} */
function settings(value) {
  if (value === null) {
    return null;
  }
  const parsed = /** @type {unknown} */ (JSON.parse(value));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Prompt model settings are invalid');
  }
  return /** @type {Record<string,unknown>} */ (parsed);
}
/** @param {Row} row @returns {Item} */
function item(row) {
  return {
    ...row,
    isFavorite: row.isFavorite === 1,
    modelSettings: settings(row.modelSettings),
    tags: tags(row.tags),
  };
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {Item|undefined} */
function get(db, id) {
  const row = /** @type {Row|undefined} */ (
    db.prepare(`SELECT ${columns} FROM prompt_items WHERE id=?`).get(id)
  );
  return row ? item(row) : undefined;
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {Item} */
function requireItem(db, id) {
  const found = get(db, id);
  if (!found) {
    throw new Error(`Prompt item "${id}" was not found.`);
  }
  return found;
}
/** @param {import('@brainstrike/types/prompt-item').CreatePromptItemInput | import('@brainstrike/types/prompt-item').UpdatePromptItemInput} input */
function values(input) {
  if (!input.content.trim()) {
    throw new Error('Prompt item content must contain non-whitespace text.');
  }
  return [
    input.kind ?? 'fragment',
    input.title?.trim() || derivePromptItemTitle(input.content),
    input.content,
    input.description?.trim() || null,
    JSON.stringify(normalizePromptItemTags(input.tags ?? [])),
    Number(input.isFavorite ?? false),
    input.sourceUrl?.trim() || null,
    input.rating ?? null,
    input.modelKey?.trim() || null,
    input.modelSettings ? JSON.stringify(input.modelSettings) : null,
  ];
}
/** @param {import('better-sqlite3').Database} db @param {import('@brainstrike/types/prompt-item').PromptItemFilter} filter @returns {Item[]} */
function list(db, filter) {
  const wantedTags = normalizePromptItemTags(filter.tags ?? []);
  const search = filter.search?.trim().toLocaleLowerCase();
  return /** @type {Row[]} */ (
    db
      .prepare(`SELECT ${columns} FROM prompt_items ORDER BY is_favorite DESC,updated_at DESC,id`)
      .all()
  )
    .map(item)
    .filter(
      (row) =>
        (filter.includeArchived || row.archivedAt === null) &&
        (!filter.favoritesOnly || row.isFavorite) &&
        (!filter.kinds?.length || filter.kinds.includes(row.kind)) &&
        wantedTags.every((tag) => row.tags.includes(tag)) &&
        (!search ||
          [row.title, row.content, row.description ?? ''].some((value) =>
            value.toLocaleLowerCase().includes(search)
          ))
    );
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {import('./prompt-catalog-types.js').PromptRevisionRecord[]} */
function revisions(db, id) {
  const rows =
    /** @type {(Omit<import('./prompt-catalog-types.js').PromptRevisionRecord,'tags'|'modelSettings'> & {tags:string;modelSettings:string|null})[]} */ (
      db
        .prepare(
          'SELECT id,prompt_item_id AS promptItemId,revision,title,content,description,tags,model_key AS modelKey,model_settings AS modelSettings,note,created_at AS createdAt FROM prompt_item_revisions WHERE prompt_item_id=? ORDER BY revision DESC'
        )
        .all(id)
    );
  return rows.map((row) => ({
    ...row,
    modelSettings: settings(row.modelSettings),
    tags: tags(row.tags),
  }));
}
/** @param {import('better-sqlite3').Database} db @param {import('./prompt-catalog-types.js').PromptCatalogRequest} request @returns {import('./prompt-catalog-types.js').PromptCatalogReply} */
export function executePromptCatalogRequest(db, request) {
  return db.transaction(
    /** @returns {import('./prompt-catalog-types.js').PromptCatalogReply} */ () => {
      const now = new Date().toISOString();
      switch (request.operation) {
        case 'list':
          return { items: list(db, request.filter), revisions: [] };
        case 'get': {
          const found = get(db, request.id);
          return { items: found ? [found] : [], revisions: [] };
        }
        case 'revisions':
          return { items: [], revisions: revisions(db, request.id) };
        case 'create': {
          const id = request.input.id ?? `prompt-item-${crypto.randomUUID()}`;
          db.prepare(
            'INSERT INTO prompt_items(id,kind,title,content,description,tags,is_favorite,source_url,rating,model_key,model_settings,revision,use_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)'
          ).run(id, ...values(request.input), now, now);
          return { items: [requireItem(db, id)], revisions: [] };
        }
        case 'update': {
          const input = request.input;
          const previous = requireItem(db, input.id);
          if (previous.revision !== input.expectedRevision) {
            throw new Error(
              `Prompt item "${input.id}" changed since it was opened (expected revision ${input.expectedRevision}, current revision ${previous.revision}).`
            );
          }
          db.prepare(
            'INSERT INTO prompt_item_revisions(id,prompt_item_id,revision,title,content,description,tags,model_key,model_settings,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
          ).run(
            `prompt-revision-${crypto.randomUUID()}`,
            previous.id,
            previous.revision,
            previous.title,
            previous.content,
            previous.description,
            JSON.stringify(previous.tags),
            previous.modelKey,
            previous.modelSettings ? JSON.stringify(previous.modelSettings) : null,
            input.note?.trim() || null,
            now
          );
          db.prepare(
            'UPDATE prompt_items SET kind=?,title=?,content=?,description=?,tags=?,is_favorite=?,source_url=?,rating=?,model_key=?,model_settings=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?'
          ).run(...values(input), now, input.id, input.expectedRevision);
          return { items: [requireItem(db, input.id)], revisions: [] };
        }
        case 'usage':
          requireItem(db, request.id);
          db.prepare(
            'UPDATE prompt_items SET use_count=use_count+1,last_used_at=?,last_used_action=? WHERE id=?'
          ).run(now, request.action, request.id);
          return { items: [requireItem(db, request.id)], revisions: [] };
        case 'delete':
          requireItem(db, request.id);
          db.prepare('DELETE FROM prompt_items WHERE id=?').run(request.id);
          db.prepare(
            "INSERT INTO brainstrike_mind_ops(entity_kind,entity_id,op) VALUES('prompt_item',?,'delete')"
          ).run(request.id);
          return { items: [], revisions: [] };
        default:
          throw new Error('Unknown prompt catalog operation');
      }
    }
  )();
}
