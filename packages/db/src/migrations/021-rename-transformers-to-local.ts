import type { Migration } from './migration-runner';

/**
 * Migration 021: Rename 'transformers' provider to 'local'
 *
 * The code registry uses 'local' as the provider ID for browser-based models,
 * but the DB was seeded with 'transformers'. This migration fixes the mismatch.
 *
 * Also makes LiquidAI the default model since FunctionGemma is designed for
 * function calling, not general chat.
 */
export const migration021RenameTransformersToLocal: Migration = {
  down: `
    -- Step 1: Insert 'transformers' provider back
    INSERT INTO providers (id, name, created_at, updated_at)
    SELECT 'transformers', 'Local Models', created_at, NOW()
    FROM providers WHERE id = 'local'
    ON CONFLICT (id) DO NOTHING;

    -- Step 2: Update models back to 'transformers' provider_id
    UPDATE models SET provider_id = 'transformers' WHERE provider_id = 'local';

    -- Step 3: Delete the 'local' provider
    DELETE FROM providers WHERE id = 'local';

    -- Step 4: Revert default model
    UPDATE models SET is_enabled = true WHERE id = 'onnx-community/functiongemma-270m-it-ONNX';
    UPDATE models SET is_enabled = false WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
  `,
  ledgerKey: 'custom-021-rename-transformers-to-local',
  name: 'rename_transformers_to_local',
  up: `
    -- Step 1: Insert new 'local' provider (copy from 'transformers' if it exists)
    -- IMPORTANT: Copy is_enabled and sort_order to preserve provider settings
    INSERT INTO providers (id, name, is_enabled, sort_order, created_at, updated_at)
    SELECT 'local', 'Local (Browser)', is_enabled, sort_order, created_at, NOW()
    FROM providers WHERE id = 'transformers'
    ON CONFLICT (id) DO NOTHING;

    -- Step 2: Update all models to reference the new 'local' provider
    UPDATE models SET provider_id = 'local' WHERE provider_id = 'transformers';

    -- Step 3: Delete the old 'transformers' provider
    DELETE FROM providers WHERE id = 'transformers';

    -- Step 4: Make LiquidAI the default enabled model (it's a proper chat model)
    -- FunctionGemma is for function calling only, disable it by default
    UPDATE models SET is_enabled = false WHERE id = 'onnx-community/functiongemma-270m-it-ONNX';
    UPDATE models SET is_enabled = true WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
  `,
  version: 21,
};
