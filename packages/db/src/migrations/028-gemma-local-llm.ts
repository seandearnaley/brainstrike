import type { Migration } from './migration-runner';

export const migration028GemmaLocalLlm: Migration = {
  version: 28,
  name: 'gemma_local_llm',
  up: `
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
  down: `
    DELETE FROM models WHERE id = 'onnx-community/gemma-4-E2B-it-ONNX';
  `,
};
