import { migration084AssistantToolProjectionRewrites } from './084-assistant-tool-projection-rewrites.js';
import { migration087ToolProjectionRewriteKinds } from './087-tool-projection-rewrite-kinds.js';
import type { Migration } from './migration-runner.js';

/**
 * Migration 145: drop the PGlite tool-projection rewrite overlay (BST-1980).
 *
 * The agent host records every rewrite as a `tool.projection.rewritten` event
 * in its own run log, and nothing has written this table since the old desktop
 * assistant path was deleted. `down` restores the empty 084 + 087 shape from
 * those migrations' own DDL.
 */
export const migration145DropToolProjectionRewrites: Migration = {
  down: `${migration084AssistantToolProjectionRewrites.up}\n${migration087ToolProjectionRewriteKinds.up}`,
  ledgerKey: 'custom-145-drop-tool-projection-rewrites',
  name: 'drop_tool_projection_rewrites',
  up: 'DROP TABLE IF EXISTS brainstrike_assistant_tool_projection_rewrites;',
  version: 145,
};
