// @ts-check
// The workspace roots table, apart from its domain so the state DB schema (schema.mjs) imports no Node module.

/**
 * Current desktop roots, committed by the agent host's root registry only (ADR-0029 stage 4).
 * `canonical_path` is the folder's identity, pinned when it was granted: a reopen that resolves
 * elsewhere is refused, never adopted. `open_position` orders the folders the person has open;
 * NULL is a folder they removed, kept for its identity, and every managed worktree and scratch
 * folder, which are a thread's own folders and never open (ADR-0034). `status` says whether a
 * folder is mounted now.
 * @param {string} table
 * @returns {string}
 */
const rootsTable = (table) => `
CREATE TABLE ${table} (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('path', 'worktree', 'scratch')),
  status TEXT NOT NULL CHECK (status IN ('live', 'disconnected')),
  open_position INTEGER CHECK (open_position IS NULL OR open_position >= 0),
  created_at REAL NOT NULL,
  last_verified_at REAL NOT NULL
) STRICT;
`;

export const WORKSPACE_ROOT_SCHEMA = rootsTable('roots');

/**
 * A thread's scratch folder (ADR-0034): a folder the host made for a thread sent with no folder
 * while none was open. The roots domain writes the row in the commit that records the folder's
 * root, whose kind it makes `scratch`, and deletes both together. A thread has one.
 */
const SCRATCH_FOLDER_SCHEMA = `
CREATE TABLE scratch_folders (
  path TEXT PRIMARY KEY NOT NULL CHECK (length(path) > 0),
  thread_id TEXT NOT NULL UNIQUE CHECK (length(thread_id) > 0),
  created_at REAL NOT NULL
) STRICT;
`;

/**
 * Version 17. SQLite cannot widen a CHECK in place, so `roots` is rebuilt with every row it holds,
 * in the order the SQLite manual gives (create, copy, drop, rename), and `scratch_folders` added.
 */
export const SCRATCH_FOLDER_UPGRADE = `
${rootsTable('roots_v17')}
INSERT INTO roots_v17 (id, path, canonical_path, display_name, kind, status, open_position,
  created_at, last_verified_at)
SELECT id, path, canonical_path, display_name, kind, status, open_position, created_at,
  last_verified_at FROM roots;
DROP TABLE roots;
ALTER TABLE roots_v17 RENAME TO roots;
${SCRATCH_FOLDER_SCHEMA}
`;
