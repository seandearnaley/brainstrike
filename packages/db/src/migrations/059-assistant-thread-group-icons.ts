import type { Migration } from './migration-runner';

/**
 * Adds durable group icon presentation alongside the group color introduced in
 * migration 056. Null preserves the folder default; explicit values share the
 * same validated icon vocabulary as assistant threads.
 */
export const migration059AssistantThreadGroupIcons: Migration = {
  down: `
    ALTER TABLE brainstrike_assistant_thread_groups
      DROP COLUMN IF EXISTS icon;
  `,
  name: 'assistant_thread_group_icons',
  up: `
    ALTER TABLE brainstrike_assistant_thread_groups
      ADD COLUMN IF NOT EXISTS icon text
      CHECK (icon IS NULL OR icon IN ('message', 'bug', 'code', 'rocket', 'research', 'plan'));
  `,
  version: 59,
};
