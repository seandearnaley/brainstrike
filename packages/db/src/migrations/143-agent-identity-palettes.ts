import type { Migration } from './migration-runner.js';

/** Expand the durable color checks while preserving existing group and child rows. */
export const migration143AgentIdentityPalettes: Migration = {
  ledgerKey: 'custom-143-agent-identity-palettes',
  name: 'agent_identity_palettes',
  up: `
    ALTER TABLE brainstrike_assistant_thread_groups
      DROP CONSTRAINT brainstrike_assistant_thread_groups_color_check;
    ALTER TABLE brainstrike_assistant_thread_groups
      ADD CONSTRAINT brainstrike_assistant_thread_groups_color_check
      CHECK (color IS NULL OR color IN (
        'blue', 'emerald', 'amber', 'rose', 'violet', 'slate',
        'cyan', 'lime', 'orange', 'fuchsia', 'indigo', 'red',
        'teal', 'green', 'yellow', 'pink', 'purple', 'zinc'
      ));

    ALTER TABLE brainstrike_delegated_conversations
      DROP CONSTRAINT brainstrike_delegated_conversations_color_check;
    ALTER TABLE brainstrike_delegated_conversations
      ADD CONSTRAINT brainstrike_delegated_conversations_color_check
      CHECK (color IN (
        'blue', 'emerald', 'amber', 'rose', 'violet', 'slate',
        'cyan', 'lime', 'orange', 'fuchsia', 'indigo', 'red',
        'teal', 'green', 'yellow', 'pink', 'purple', 'zinc'
      ));
  `,
  version: 143,
};
