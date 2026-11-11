// @ts-check
// The project tables, apart from their domain so the state DB schema (schema.mjs) imports no Node module.

/**
 * A project is a record with an id of its own (ADR-0034, owner decisions 2026-11-10), so the
 * folder it is kept in locates it and is not its identity.
 *
 * `project_folders` says which project the folder at a canonical path belongs to. A folder is
 * the place a project is kept: a repository's own checkout, or a folder outside a repository. A
 * root recorded as a managed worktree gets no row; it is a checkout of its repository. One
 * project may have several folders; a folder has one project.
 *
 * The roots domain is the only writer, in the commit that records an opened folder
 * (workspace-root-domain.mjs), so a folder recorded from version 16 on always has a project.
 */
export const PROJECT_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  created_at REAL NOT NULL
) STRICT;
CREATE TABLE project_folders (
  canonical_path TEXT PRIMARY KEY NOT NULL CHECK (length(canonical_path) > 0),
  project_id TEXT NOT NULL REFERENCES projects (id)
) STRICT;
`;
