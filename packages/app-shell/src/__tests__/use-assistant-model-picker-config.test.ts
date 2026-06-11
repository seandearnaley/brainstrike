import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LlmProviderModelDefinition } from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantModelPickerConfig } from '../hooks/use-assistant-model-picker-config';

const openAiDefaultModel: LlmProviderModelDefinition = {
  id: 'hosted-default',
  label: 'Hosted Default',
  type: 'llm',
  supportsStreaming: true,
  default: true,
  contextWindow: 200_000,
};

const openAiDisabledModel: LlmProviderModelDefinition = {
  id: 'hosted-disabled',
  label: 'Hosted Disabled',
  type: 'llm',
  supportsStreaming: true,
  contextWindow: 200_000,
};

const ollamaModel: LlmProviderModelDefinition = {
  id: 'llama3.2',
  label: 'Llama 3.2',
  type: 'llm',
  supportsStreaming: true,
  contextWindow: 200_000,
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
        runtime: 'hosted',
        label: 'Hosted',
        providers: [
          expect.objectContaining({
            id: 'openai',
            name: 'OpenAI',
            runtime: 'hosted',
            capabilities: expect.objectContaining({
              llm: true,
              supportsStandardEmbeddingDimension: true,
            }),
            models: expect.arrayContaining([
              expect.objectContaining({
                id: 'hosted-default',
                label: 'Hosted Default',
                enabled: true,
                default: true,
                supportsStreaming: true,
                type: 'llm',
              }),
              expect.objectContaining({
                id: 'hosted-disabled',
                enabled: false,
              }),
            ]),
          }),
        ],
      },
      {
        runtime: 'local',
        label: 'Local',
        providers: [
          expect.objectContaining({
            id: 'ollama',
            name: 'Ollama (Local Runtime)',
            runtime: 'local',
            capabilities: expect.objectContaining({
              llm: true,
              supportsStandardEmbeddingDimension: false,
            }),
            models: [
              {
                id: 'llama3.2',
                label: 'Llama 3.2',
                enabled: true,
                default: false,
                supportsStreaming: true,
                type: 'llm',
              },
            ],
          }),
        ],
      },
    ]);
    expect(result.current.pickerProviders).toEqual([
      { id: 'openai', name: 'OpenAI', icon: null },
      { id: 'ollama', name: 'Ollama (Local Runtime)', icon: null },
    ]);
    expect(result.current.pickerModels).toEqual([
      {
        id: 'hosted-default',
        providerId: 'openai',
        name: 'Hosted Default',
        description: null,
        contextWindow: 200_000,
        capabilities: { type: 'llm', streaming: true },
      },
      {
        id: 'llama3.2',
        providerId: 'ollama',
        name: 'Llama 3.2',
        description: null,
        contextWindow: 200_000,
        capabilities: { type: 'llm', streaming: true },
      },
    ]);
  });
});
