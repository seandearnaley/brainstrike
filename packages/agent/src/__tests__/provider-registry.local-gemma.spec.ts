import { describe, expect, it } from 'vitest';
import { getProviderDefinition } from '../providers/types';

describe('provider registry local Gemma support', () => {
  it('surfaces only Gemma 4 E2B for the built-in local provider', () => {
    const local = getProviderDefinition('local');
    const llmModels = local.models.filter((model) => model.type === 'llm');

    expect(llmModels).toHaveLength(1);
    expect(llmModels[0]?.id).toBe('onnx-community/gemma-4-E2B-it-ONNX');
    expect(llmModels[0]?.supportsStreaming).toBe(false);
    expect(llmModels[0]?.default).toBe(true);
  });
});
