import { migration050AssistantTaskLists } from './050-assistant-task-lists.js';
import { migration082CanvasDocuments } from './082-canvas-documents.js';
import { migration088AssistantCompactionRanges } from './088-assistant-compaction-ranges.js';
import type { Migration } from './migration-runner.js';

/**
 * Migration 146: drop three unwritten PGlite chat sidecars (BST-1980).
 *
 * The agent host owns task lists and canvases as `tool.state.updated` rows in
 * its own run log, and nothing has written any of these tables since the old
 * desktop assistant path was deleted: the task list, Canvas versions and
 * conversation-compaction ranges. `down` restores the empty 050, 082 and 088
 * shapes from those migrations' own DDL.
 */
export const migration146DropPgliteChatSidecars: Migration = {
  down: `${migration050AssistantTaskLists.up}\n${migration082CanvasDocuments.up}\n${migration088AssistantCompactionRanges.up}`,
  ledgerKey: 'custom-146-drop-pglite-chat-sidecars',
  name: 'drop_pglite_chat_sidecars',
  up: `
    DROP TABLE IF EXISTS brainstrike_assistant_task_lists;
    DROP TABLE IF EXISTS brainstrike_canvas_versions;
    DROP TABLE IF EXISTS brainstrike_assistant_compaction_ranges;
  `,
  version: 146,
};
