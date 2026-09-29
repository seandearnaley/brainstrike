import type { Migration } from './migration-runner.js';

/** Existing semantic identities remain valid; child accents gain canonical coordinates. */
export const migration144AgentFamilyColors: Migration = {
  down: `
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
  ledgerKey: 'custom-144-agent-family-colors',
  name: 'agent_family_colors',
  up: `
    ALTER TABLE brainstrike_delegated_conversations
      DROP CONSTRAINT brainstrike_delegated_conversations_color_check;
    ALTER TABLE brainstrike_delegated_conversations
      ADD CONSTRAINT brainstrike_delegated_conversations_color_check
      CHECK (color IN (
        'blue', 'emerald', 'amber', 'rose', 'violet', 'slate',
        'cyan', 'lime', 'orange', 'fuchsia', 'indigo', 'red',
        'teal', 'green', 'yellow', 'pink', 'purple', 'zinc'
      ) OR CASE
        WHEN color ~ '^family:(0|[1-9][0-9]{0,3}):(0|[1-9][0-9]{0,2})$'
        THEN split_part(color, ':', 2)::integer <= 3599
          AND split_part(color, ':', 3)::integer <= 999
        ELSE FALSE
      END);
  `,
  version: 144,
};
