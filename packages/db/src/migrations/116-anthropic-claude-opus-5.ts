import type { Migration } from './migration-runner.js';

// Direct-provider catalog route for Anthropic Claude Opus 5 (BST-957).
// Vendor model-overview facts, retrieved 2026-09-04:
// https://platform.claude.com/docs/en/about-claude/models/overview
/** Add Claude Opus 5 as the second direct Anthropic catalog entry. */
export const migration116AnthropicClaudeOpus5: Migration = {
  down: `
    WITH removed AS (
      DELETE FROM models
      WHERE provider_id = 'anthropic' AND id = 'claude-opus-5'
      RETURNING sort_order
    )
    UPDATE models SET sort_order = sort_order - 1
    WHERE provider_id = 'anthropic'
      AND sort_order > (SELECT sort_order FROM removed);
  `,
  ledgerKey: 'custom-116-anthropic-claude-opus-5',
  name: 'anthropic_claude_opus_5',
  up: `
    UPDATE models SET sort_order = sort_order + 1
    WHERE provider_id = 'anthropic' AND id <> 'claude-opus-5' AND sort_order >= 2
      AND EXISTS (
        SELECT 1 FROM models
        WHERE provider_id = 'anthropic' AND id <> 'claude-opus-5' AND sort_order = 2
      );
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'claude-opus-5',
        'anthropic',
        'Claude Opus 5',
        'For complex agentic coding and enterprise work',
        '["Agentic coding","Enterprise work"]',
        '{"type":"llm","streaming":true,"vision":true}',
        2,
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
  version: 116,
};
