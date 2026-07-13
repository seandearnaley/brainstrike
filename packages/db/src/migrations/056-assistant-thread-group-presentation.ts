import type { Migration } from './migration-runner';

/**
 * Presentation metadata for assistant thread groups and independent flat-list
 * ordering for thread placements.
 *
 * `color` is nullable by design: null is the explicit unassigned state. The
 * database constraint mirrors the curated thread palette so malformed values
 * fail at the storage boundary. `flat_rank` is separate from the existing
 * grouped `rank`; sharing one rank would couple manual ordering across the flat
 * and grouped presentations. Existing rows start with the legacy rank in both
 * columns so their custom order remains stable when the presentations split.
 */
export const migration056AssistantThreadGroupPresentation: Migration = {
  down: `
    ALTER TABLE brainstrike_assistant_thread_placements
      DROP COLUMN IF EXISTS flat_rank;
    ALTER TABLE brainstrike_assistant_thread_groups
      DROP COLUMN IF EXISTS color;
  `,
  name: 'assistant_thread_group_presentation',
  up: `
    ALTER TABLE brainstrike_assistant_thread_groups
      ADD COLUMN IF NOT EXISTS color text
      CHECK (color IS NULL OR color IN ('blue', 'emerald', 'amber', 'rose', 'violet', 'slate'));

    ALTER TABLE brainstrike_assistant_thread_placements
      ADD COLUMN IF NOT EXISTS flat_rank text;

    UPDATE brainstrike_assistant_thread_placements
      SET flat_rank = rank
      WHERE flat_rank IS NULL;
  `,
  version: 56,
};
