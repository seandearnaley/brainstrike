// @ts-check
/** Clear Database retains configuration, unlike factory reset. All content is
 * deleted by the existing writer after the host has joined its run owners. */
const CONTENT_TABLES = [
  'brainstrike_mcp_tasks',
  'brainstrike_mcp_task_authorities',
  'brainstrike_memory_entities',
  'brainstrike_memory_scopes',
  'brainstrike_worktrees',
  'thread_pins',
  'thread_placements',
  'thread_groups',
  'threads',
  'run_events',
  'run_sync',
  'purge_intent',
  'roots',
  // A project goes with the folders and threads it groups; its folders first, which reference it.
  'project_folders',
  'projects',
];

/** @param {import('better-sqlite3').Database} db */
export function clearContentRows(db) {
  db.transaction(() => {
    for (const table of CONTENT_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
  })();
}
