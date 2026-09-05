import type { Migration } from './migration-runner';

/**
 * Migration 020: Add local LLM models for browser-based inference
 *
 * Adds support for running LLMs locally using transformers.js and ONNX:
 * - onnx-community/functiongemma-270m-it-ONNX: Function calling specialist (270M params)
 * - LiquidAI/LFM2.5-1.2B-Instruct-ONNX: LiquidAI LFM2.5 hybrid model for edge deployment (1.2B params)
 * - onnx-community/Qwen3-0.6B-ONNX: Fast, efficient Qwen3 model (600M params)
 *
 * NOTE: Qwen3-1.7B-ONNX removed due to WebGPU buffer size issues causing crashes.
 * The model's large embedding layer exceeds browser WebGPU limits.
 * See: https://github.com/huggingface/transformers.js/issues/1469
 *
 * All models are tagged with 'transformers.js' on HuggingFace and verified to work.
 */
export const migration020LocalLlmModels: Migration = {
  down: `
    DELETE FROM models WHERE id IN (
      'onnx-community/functiongemma-270m-it-ONNX',
      'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
      'onnx-community/Qwen3-0.6B-ONNX'
    );
  `,
  ledgerKey: 'custom-020-local-llm-models',
  name: 'local_llm_models',
  up: `
    -- Remove Qwen3-1.7B if it exists (crashes due to WebGPU buffer limits)
    DELETE FROM models WHERE id = 'onnx-community/Qwen3-1.7B-ONNX';

    -- Add local LLM models to the transformers provider
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, parameters, sort_order, is_enabled)
    VALUES
      (
        'onnx-community/functiongemma-270m-it-ONNX',
        'transformers',
        'FunctionGemma 270M',
        'Lightweight function calling specialist',
        '["Tool calling", "On-device agents", "Mobile"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~270MB","architecture":"Gemma 3 270M","quantization":"fp16/int8"}',
        10,
        true
      ),
      (
        'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
        'transformers',
        'LFM2.5 1.2B Instruct',
        'LiquidAI hybrid model for edge deployment',
        '["General tasks", "Instruction following", "Edge/Mobile", "Tool calling"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~1.2GB (q4)","architecture":"LFM2","quantization":"q4/fp16"}',
        11,
        false
      ),
      (
        'onnx-community/Qwen3-0.6B-ONNX',
        'transformers',
        'Qwen3 0.6B',
        'Fast and efficient for general tasks',
        '["General tasks", "Quick responses", "Low memory", "Tool calling"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~600MB (q4)","architecture":"Qwen3","quantization":"q4/fp16"}',
        12,
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      parameters = EXCLUDED.parameters,
      updated_at = CURRENT_TIMESTAMP;
  `,
  version: 20,
};
