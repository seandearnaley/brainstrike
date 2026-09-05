import type { Migration } from './migration-runner';

/**
 * Amazon Nova 2 Lite catalog row (BST-1354).
 *
 * Added alongside Bedrock reasoning support: Nova 2 Lite is the ONLY Nova
 * route AWS documents extended thinking for, so it is what the
 * `max-reasoning-effort` dialect is declared on. A registry row with no
 * catalog row is invisible to the DB-backed model pickers — the dialect would
 * ship as dead code — and `scripts/model-catalog-migration-contract.mjs` fails
 * the build for exactly that mismatch.
 *
 * Mirrors the static registry entry (packages/assistant-contract/src/
 * provider-registry.ts). Vision is TRUE: models.dev reports
 * `modalities.input: [text, image, video]` for this route. (The row's sibling
 * `attachment: false` field is about file attachments, not image input — do
 * not derive vision from it.)
 *
 * Ships `is_enabled = false` like every other Bedrock row (migration 101); the
 * user enables it from Settings. It is deliberately NOT added to
 * `BEDROCK_RECOMMENDED_MODEL_IDS`, which stays a curated two-model Claude
 * starter set.
 *
 * `sort_order` 12 appends after DeepSeek (11) rather than renumbering the
 * existing rows to match the registry's Nova grouping — sort_order drives
 * db-explorer display only, and rewriting settled rows to move one entry is
 * not worth the migration surface.
 */
export const migration102AmazonNova2Lite: Migration = {
  down: `
    DELETE FROM models WHERE id = 'amazon.nova-2-lite-v1:0' AND provider_id = 'bedrock';
  `,
  ledgerKey: 'custom-102-amazon-nova-2-lite',
  name: 'amazon_nova_2_lite',
  up: `
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'amazon.nova-2-lite-v1:0',
        'bedrock',
        'Amazon Nova 2 Lite',
        'Reasoning Nova at low cost',
        '["Reasoning", "Visual analysis", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":true}',
        12,
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
  `,
  version: 102,
};
