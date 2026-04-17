import { describe, expect, it } from 'vitest';
import {
  GEMMA4_E2B_MODEL_ID,
  getLocalLlmModelSpec,
  listLocalLlmModelSpecs,
} from '../local-model-specs';

describe('local-model-specs', () => {
  it('exposes Gemma 4 E2B as the only built-in local LLM', () => {
    const specs = listLocalLlmModelSpecs();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.modelId).toBe(GEMMA4_E2B_MODEL_ID);
  });

  it('defines an explicit text-only manifest for Gemma 4 E2B', () => {
    const spec = getLocalLlmModelSpec(GEMMA4_E2B_MODEL_ID);

    expect(spec).toBeDefined();
    expect(spec?.family).toBe('gemma4');
    expect(spec?.requiredDevice).toBe('webgpu');
    expect(spec?.artifacts.text.length).toBeGreaterThan(0);
    expect(spec?.artifacts.vision).toBeUndefined();
    expect(spec?.artifacts.audio).toBeUndefined();
  });

  it('lists chat_template.jinja (not .json) in the artifact manifest', () => {
    const spec = getLocalLlmModelSpec(GEMMA4_E2B_MODEL_ID);

    expect(spec?.artifacts.text).toContain('chat_template.jinja');
    expect(spec?.artifacts.text).not.toContain('chat_template.json');
  });

  it('does not include removed legacy local LLMs', () => {
    expect(getLocalLlmModelSpec('LiquidAI/LFM2.5-1.2B-Instruct-ONNX')).toBeUndefined();
    expect(getLocalLlmModelSpec('onnx-community/Qwen3-0.6B-ONNX')).toBeUndefined();
    expect(getLocalLlmModelSpec('onnx-community/functiongemma-270m-it-ONNX')).toBeUndefined();
  });
});
