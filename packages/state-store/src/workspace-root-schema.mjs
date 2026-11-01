// @ts-check
// The workspace roots table, apart from its domain so the state DB schema (schema.mjs) imports no Node module.

/**
 * Current desktop roots, committed by the agent host's root registry only (ADR-0029 stage 4).
 * `canonical_path` is the folder's identity, pinned when it was granted: a reopen that resolves
 * elsewhere is refused, never adopted. `open_position` orders the folders the person has open;
 * NULL is a folder they removed, kept for its identity. `status` says whether an open folder is
 * mounted now.
 */
export const WORKSPACE_ROOT_SCHEMA = `
CREATE TABLE roots (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('path', 'worktree')),
  status TEXT NOT NULL CHECK (status IN ('live', 'disconnected')),
  open_position INTEGER CHECK (open_position IS NULL OR open_position >= 0),
  created_at REAL NOT NULL,
  last_verified_at REAL NOT NULL
) STRICT;
`;
