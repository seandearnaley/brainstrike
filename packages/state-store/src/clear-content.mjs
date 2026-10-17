// @ts-check
/** Clear Database retains configuration, unlike factory reset. All content is
 * deleted by the existing writer after the host has joined its run owners. */
const CONTENT_TABLES = [
  'brainstrike_mcp_tasks',
  'brainstrike_mcp_task_authorities',
  'brainstrike_memory_entities',
  'brainstrike_memory_scopes',
  'brainstrike_mind_ops',
  'brainstrike_worktrees',
  'brainstrike_forge_prs',
  'thread_placements',
  'thread_groups',
  'prompt_item_revisions',
  'prompt_items',
  'threads',
  'run_events',
  'run_sync',
  'purge_intent',
  'file_records',
  'source_blob_gc',
  'roots',
  'embedding_sets',
];

/** @param {import('better-sqlite3').Database} db */
export function clearContentRows(db) {
  return db.transaction(() => {
    const row = /** @type {{files:number;unknown:number;chunks:number|null}} */ (
      db
        .prepare(
          'SELECT COUNT(*) AS files, COUNT(*)-COUNT(chunks_count) AS unknown, SUM(chunks_count) AS chunks FROM file_records'
        )
        .get()
    );
    for (const table of CONTENT_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    return { deletedChunks: row.unknown > 0 ? null : (row.chunks ?? 0), deletedFiles: row.files };
  })();
}
