import type { Migration } from './migration-runner';

/**
 * Migration 024: Fix tool calling capability flags for local LLM models
 *
 * Migration 020 incorrectly set toolCalling:false for LFM2.5 and Qwen3-0.6B,
 * but both models actually support tool calling as evidenced by:
 * - MODELS_SUPPORTING_TOOLS in local-llm-backend.ts includes both
 * - Tool formatting logic handles LFM2.5 and Qwen formats
 * - Tests verify LFM2.5 tool call parsing works
 *
 * This migration fixes the capabilities JSON for existing databases.
 */
export const migration024FixLlmToolCalling: Migration = {
  down: `
    -- Revert to original (incorrect) values
    UPDATE models
    SET
      capabilities = '{"type":"llm","streaming":false,"toolCalling":false,"contextWindow":32768}',
      best_for = '["General tasks", "Instruction following", "Edge/Mobile"]',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';

    UPDATE models
    SET
      capabilities = '{"type":"llm","streaming":false,"toolCalling":false,"contextWindow":32768}',
      best_for = '["General tasks", "Quick responses", "Low memory"]',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 'onnx-community/Qwen3-0.6B-ONNX';
  `,
  name: 'fix_llm_tool_calling',
  up: `
    -- Fix LFM2.5 tool calling capability
    UPDATE models
    SET
      capabilities = '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
      best_for = '["General tasks", "Instruction following", "Edge/Mobile", "Tool calling"]',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';

    -- Fix Qwen3-0.6B tool calling capability
    UPDATE models
    SET
      capabilities = '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":32768}',
      best_for = '["General tasks", "Quick responses", "Low memory", "Tool calling"]',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 'onnx-community/Qwen3-0.6B-ONNX';
  `,
  version: 24,
};
