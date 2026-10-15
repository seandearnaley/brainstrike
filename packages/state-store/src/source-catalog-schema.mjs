// @ts-check
// The source catalog's tables, apart from its domain so the state DB schema (schema.mjs) imports no Node module.

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
