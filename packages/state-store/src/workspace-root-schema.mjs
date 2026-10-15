// @ts-check
// The workspace roots table, apart from its domain so the state DB schema (schema.mjs) imports no Node module.

/** Current desktop roots, committed by the existing StateStore writer only. */
export const WORKSPACE_ROOT_SCHEMA = `
CREATE TABLE roots (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('path', 'worktree')),
  status TEXT NOT NULL CHECK (status IN ('live', 'disconnected')),
  created_at REAL NOT NULL,
  last_verified_at REAL NOT NULL
) STRICT;
`;
