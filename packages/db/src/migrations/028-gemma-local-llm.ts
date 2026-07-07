import type { Migration } from './migration-runner';

export const migration028GemmaLocalLlm: Migration = {
  down: `
    -- Rollback note:
    -- - This restores the legacy built-in local model rows, but it does not restore user-customized
    --   is_enabled values that may have existed before migration 028.
    -- - App-level assistant preference migrations only remap legacy local selections -> Gemma.
    --   Reverting this migration may therefore require clearing persisted assistant preferences that
    --   still point at the Gemma local model id.
    DELETE FROM models WHERE id = 'onnx-community/gemma-4-E2B-it-ONNX';

    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, parameters, sort_order, is_enabled)
    VALUES
      (
        'onnx-community/functiongemma-270m-it-ONNX',
        'local',
        'FunctionGemma 270M',
        'Lightweight function calling specialist',
        '["Tool calling", "On-device agents", "Mobile"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~270MB","architecture":"Gemma 3 270M","quantization":"fp16/int8"}',
        10,
        false
      ),
      (
        'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
        'local',
        'LFM2.5 1.2B Instruct',
        'LiquidAI hybrid model for edge deployment',
        '["General tasks", "Instruction following", "Edge/Mobile", "Tool calling"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~1.2GB (q4)","architecture":"LFM2","quantization":"q4/fp16"}',
        11,
        true
      ),
      (
        'onnx-community/Qwen3-0.6B-ONNX',
        'local',
        'Qwen3 0.6B',
        'Fast and efficient for general tasks',
        '["General tasks", "Quick responses", "Low memory", "Tool calling"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~600MB (q4)","architecture":"Qwen3","quantization":"q4/fp16"}',
        12,
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      parameters = EXCLUDED.parameters,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled,
      updated_at = CURRENT_TIMESTAMP;
  `,
  name: 'gemma_local_llm',
  up: `
    -- Audit note:
    -- - The database schema does not contain inbound foreign keys to models(id), so removing
    --   built-in model rows here will not cascade user data or block migration 028.
    -- - App-level local model selections are remapped to Gemma in
    --   packages/preferences/src/stores/assistant-preferences-store.ts.
    DELETE FROM models
    WHERE id IN (
      'onnx-community/functiongemma-270m-it-ONNX',
      'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
      'onnx-community/Qwen3-0.6B-ONNX'
    );

    INSERT INTO models (
      id,
      provider_id,
      name,
      tagline,
      best_for,
      capabilities,
      parameters,
      sort_order,
      is_enabled
    )
    VALUES (
      'onnx-community/gemma-4-E2B-it-ONNX',
      'local',
      'Gemma 4 E2B',
      'Desktop and browser local reasoning model with WebGPU acceleration',
      '["General tasks", "Coding", "Tool calling", "Local reasoning"]',
      '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":131072}',
      '{"size":"~3.9GB (text-only q4f16)","architecture":"Gemma 4 E2B","quantization":"q4f16","device":"webgpu"}',
      10,
      true
    )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      parameters = EXCLUDED.parameters,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled,
      updated_at = CURRENT_TIMESTAMP;
  `,
  version: 28,
};
