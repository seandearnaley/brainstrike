import type { Migration } from './migration-runner';

/**
 * MiniMax M3 accepts image input on OpenRouter. Migration 061 predated that
 * published multimodal contract and marked the existing catalog row false.
 * Correct the persisted picker capability without changing user enablement or
 * catalog-choice timestamps.
 */
export const migration070MinimaxM3Vision: Migration = {
  down: `
    UPDATE models
    SET capabilities = capabilities || '{"vision":false}'::jsonb
    WHERE id = 'minimax/minimax-m3' AND capabilities->>'type' = 'llm';
  `,
  ledgerKey: 'custom-070-minimax-m3-vision',
  name: 'minimax_m3_vision',
  up: `
    UPDATE models
    SET capabilities = capabilities || '{"vision":true}'::jsonb
    WHERE id = 'minimax/minimax-m3' AND capabilities->>'type' = 'llm';
  `,
  version: 70,
};
