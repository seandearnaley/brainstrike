import type { Migration } from './migration-runner';

/**
 * Migration 020: Add local LLM models for browser-based inference
 *
 * Adds support for running LLMs locally using transformers.js and ONNX:
 * - onnx-community/functiongemma-270m-it-ONNX: Function calling specialist (270M params)
 * - onnx-community/Llama-3.2-1B-Instruct-ONNX: Llama 3.2 for on-device deployment (1B params)
 * - onnx-community/Qwen3-0.6B-ONNX: Fast, efficient Qwen3 model (600M params)
 * - onnx-community/Qwen3-1.7B-ONNX: More capable Qwen3 model (1.7B params)
 *
 * All models are tagged with 'transformers.js' on HuggingFace and verified to work.
 */
export const migration020LocalLlmModels: Migration = {
  version: 20,
  name: 'local_llm_models',
  up: `
    -- Remove incompatible LiquidAI model (lfm2 architecture not supported by transformers.js)
    DELETE FROM models WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';

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
        'onnx-community/Llama-3.2-1B-Instruct-ONNX',
        'transformers',
        'Llama 3.2 1B Instruct',
        'Meta Llama 3.2 for on-device deployment',
        '["General tasks", "Instruction following", "Desktop"]',
        '{"type":"llm","streaming":false,"toolCalling":false,"contextWindow":131072}',
        '{"size":"~1GB (q4)","architecture":"Llama","quantization":"q4/fp16"}',
        11,
        false
      ),
      (
        'onnx-community/Qwen3-0.6B-ONNX',
        'transformers',
        'Qwen3 0.6B',
        'Fast and efficient for general tasks',
        '["General tasks", "Quick responses", "Low memory"]',
        '{"type":"llm","streaming":false,"toolCalling":false,"contextWindow":32768}',
        '{"size":"~600MB (q4)","architecture":"Qwen3","quantization":"q4/fp16"}',
        12,
        false
      ),
      (
        'onnx-community/Qwen3-1.7B-ONNX',
        'transformers',
        'Qwen3 1.7B',
        'More capable for complex reasoning',
        '["Complex tasks", "Better reasoning", "Desktop"]',
        '{"type":"llm","streaming":false,"toolCalling":false,"contextWindow":32768}',
        '{"size":"~1.7GB (q4)","architecture":"Qwen3","quantization":"q4/fp16"}',
        13,
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
  down: `
    DELETE FROM models WHERE id IN (
      'onnx-community/functiongemma-270m-it-ONNX',
      'onnx-community/Llama-3.2-1B-Instruct-ONNX',
      'onnx-community/Qwen3-0.6B-ONNX',
      'onnx-community/Qwen3-1.7B-ONNX'
    );
  `,
};
