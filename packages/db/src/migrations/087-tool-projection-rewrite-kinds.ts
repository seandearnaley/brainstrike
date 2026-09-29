import type { Migration } from './migration-runner';

/**
 * Migration 087: distinguish supersession overlays from deterministic recency
 * pruning overlays (BST-1200, Layer 2).
 *
 * `kind` is CHECK-constrained so replay never guesses which validity rule a
 * row uses. Existing rows backfill to `supersession` through the default.
 * `superseded_by_tool_call_id` becomes nullable because a prune is justified
 * by durable age/window selection, not by a later tool call. The named CHECK
 * ties nullability to kind: supersession rows require their live-evidence
 * guard, while prune rows must not carry a fabricated superseder.
 *
 * The constraint-install block is catalog-guarded because migration SQL is
 * also exercised idempotently in tests and the renderer bootstrap may already
 * have created the final table shape. NO foreign keys: numbered migrations
 * still run without Mastra's lazy thread and message tables.
 *
 * `down` deletes every `kind = 'prune'` row before restoring the
 * migration-084 `NOT NULL` on `superseded_by_tool_call_id` — those rows are
 * a rebuildable transient overlay (recency pruning re-derives them
 * deterministically from persisted history), so dropping them on rollback is
 * correct, and without the delete the `SET NOT NULL` fails outright once any
 * prune row exists.
 */
export const migration087ToolProjectionRewriteKinds: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_assistant_tool_projection_rewrites
      DROP CONSTRAINT IF EXISTS brainstrike_tool_projection_rewrite_kind_superseder_check;
    DELETE FROM brainstrike_assistant_tool_projection_rewrites
      WHERE superseded_by_tool_call_id IS NULL;
    ALTER TABLE IF EXISTS brainstrike_assistant_tool_projection_rewrites
      ALTER COLUMN superseded_by_tool_call_id SET NOT NULL;
    ALTER TABLE IF EXISTS brainstrike_assistant_tool_projection_rewrites
      DROP COLUMN IF EXISTS kind;
  `,
  ledgerKey: 'custom-087-tool-projection-rewrite-kinds',
  name: 'tool_projection_rewrite_kinds',
  up: `
    ALTER TABLE brainstrike_assistant_tool_projection_rewrites
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'supersession'
      CHECK (kind IN ('supersession', 'prune'));

    ALTER TABLE brainstrike_assistant_tool_projection_rewrites
      ALTER COLUMN superseded_by_tool_call_id DROP NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'brainstrike_tool_projection_rewrite_kind_superseder_check'
          AND conrelid = 'brainstrike_assistant_tool_projection_rewrites'::regclass
      ) THEN
        ALTER TABLE brainstrike_assistant_tool_projection_rewrites
          ADD CONSTRAINT brainstrike_tool_projection_rewrite_kind_superseder_check
          CHECK (
            (kind = 'supersession' AND superseded_by_tool_call_id IS NOT NULL)
            OR (kind = 'prune' AND superseded_by_tool_call_id IS NULL)
          );
      END IF;
    END
    $$;
  `,
  version: 87,
};
