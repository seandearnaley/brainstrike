import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LlmProviderModelDefinition } from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantModelPickerConfig } from '../hooks/use-assistant-model-picker-config';

const openAiDefaultModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  default: true,
  id: 'hosted-default',
  label: 'Hosted Default',
  supportsStreaming: true,
  type: 'llm',
};

const openAiDisabledModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'hosted-disabled',
  label: 'Hosted Disabled',
  supportsStreaming: true,
  type: 'llm',
};

const ollamaModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'llama3.2',
  label: 'Llama 3.2',
  supportsStreaming: true,
  type: 'llm',
};

describe('useAssistantModelPickerConfig', () => {
  it('builds grouped provider config and picker models from enabled LLM definitions', () => {
    const getProviderLlmModels = vi.fn((provider) => {
      if (provider === 'ollama') {
        return [ollamaModel];
      }
      return [openAiDefaultModel, openAiDisabledModel];
    });
    const isModelEnabled = vi.fn((_providerId, modelId) =>
      ['hosted-default', 'llama3.2'].includes(modelId)
    );

    const { result } = renderHook(() =>
      useAssistantModelPickerConfig({
        configuredProviders: ['openai', 'ollama'],
        getProviderLlmModels,
        isModelEnabled,
      })
    );

    expect(result.current.providerGroups).toEqual([
      {
        label: 'Hosted',
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              llm: true,
              supportsStandardEmbeddingDimension: true,
            }),
            id: 'openai',
            models: expect.arrayContaining([
              expect.objectContaining({
                default: true,
                enabled: true,
                id: 'hosted-default',
                label: 'Hosted Default',
                supportsStreaming: true,
                type: 'llm',
              }),
              expect.objectContaining({
                enabled: false,
                id: 'hosted-disabled',
              }),
            ]),
            name: 'OpenAI',
            runtime: 'hosted',
          }),
        ],
        runtime: 'hosted',
      },
      {
        label: 'Local',
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              llm: true,
              supportsStandardEmbeddingDimension: false,
            }),
            id: 'ollama',
            models: [
              {
                default: false,
                enabled: true,
                id: 'llama3.2',
                label: 'Llama 3.2',
                supportsStreaming: true,
                type: 'llm',
              },
            ],
            name: 'Ollama (Local Runtime)',
            runtime: 'local',
          }),
        ],
        runtime: 'local',
      },
    ]);
    expect(result.current.pickerProviders).toEqual([
      { icon: null, id: 'openai', name: 'OpenAI' },
      { icon: null, id: 'ollama', name: 'Ollama (Local Runtime)' },
    ]);
    expect(result.current.pickerModels).toEqual([
      {
        capabilities: { streaming: true, type: 'llm' },
        contextWindow: 200_000,
        description: null,
        id: 'hosted-default',
        name: 'Hosted Default',
        providerId: 'openai',
      },
      {
        capabilities: { streaming: true, type: 'llm' },
        contextWindow: 200_000,
        description: null,
        id: 'llama3.2',
        name: 'Llama 3.2',
        providerId: 'ollama',
      },
    ]);
  });
});
