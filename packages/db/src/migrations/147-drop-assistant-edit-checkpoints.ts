import { migration052AssistantEditCheckpoints } from './052-assistant-edit-checkpoints.js';
import type { Migration } from './migration-runner.js';

/**
 * Migration 147: drop the edit-checkpoint journal (BST-1980).
 *
 * The agent host records each edit, and its reverts, in its own run log; the
 * desktop undo engine, checkpoint IPC and journal readers that read this table
 * are gone, and nothing has written it since the old desktop assistant path
 * was deleted. `down` restores the empty 052 shape from that migration's DDL.
 */
export const migration147DropAssistantEditCheckpoints: Migration = {
  down: migration052AssistantEditCheckpoints.up,
  ledgerKey: 'custom-147-drop-assistant-edit-checkpoints',
  name: 'drop_assistant_edit_checkpoints',
  up: `
    DROP TABLE IF EXISTS brainstrike_assistant_edit_checkpoints;
  `,
  version: 147,
};
