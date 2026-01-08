import type { Migration } from './migration-runner';

/**
 * Migration 020: Add local LLM models for browser-based inference
 *
 * Adds support for running LLMs locally using transformers.js and ONNX:
 * - LiquidAI/LFM2.5-1.2B-Instruct-ONNX: Hybrid model for on-device deployment
 * - onnx-community/Qwen3-4B-Instruct-2507-ONNX: Tool-calling capable model
 * - onnx-community/functiongemma-270m-it-ONNX: Function calling specialist (270M params)
 *
 * These models support tool/function calling via chat templates.
 */
export const migration020LocalLlmModels: Migration = {
  version: 20,
  name: 'local_llm_models',
  up: `
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
        'LiquidAI LFM 2.5 1.2B',
        'Hybrid model for on-device deployment',
        '["Agentic workflows", "Complex tasks", "Desktop"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~1.2GB","architecture":"LFM2 Hybrid","quantization":"fp16/int8"}',
        11,
        false
      ),
      (
        'onnx-community/Qwen3-4B-Instruct-2507-ONNX',
        'transformers',
        'Qwen3 4B Instruct',
        'Powerful tool-calling model',
        '["Function calling", "Reasoning", "High-end desktop"]',
        '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
        '{"size":"~4GB","architecture":"Qwen3","quantization":"q4/q8"}',
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
  down: `
    DELETE FROM models WHERE id IN (
      'onnx-community/functiongemma-270m-it-ONNX',
      'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
      'onnx-community/Qwen3-4B-Instruct-2507-ONNX'
    );
  `,
};
