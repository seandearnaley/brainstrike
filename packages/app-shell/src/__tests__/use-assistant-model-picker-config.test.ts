import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LlmProviderModelDefinition } from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantModelPickerConfig } from '../hooks/use-assistant-model-picker-config';

const openAiDefaultModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  default: true,
  id: 'hosted-default',
  label: 'Hosted Default',
  maxOutputTokens: 64_000,
  supportsStreaming: true,
  tagline: 'Most capable for everyday work',
  type: 'llm',
  vendor: 'openai',
  vision: 'supported',
};

const openAiDisabledModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'hosted-disabled',
  label: 'Hosted Disabled',
  maxOutputTokens: 64_000,
  supportsStreaming: true,
  type: 'llm',
  vendor: 'openai',
  vision: 'unsupported',
};

const gatewayModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'vendor/uncatalogued',
  label: 'Uncatalogued',
  maxOutputTokens: 64_000,
  supportsStreaming: true,
  type: 'llm',
  vendor: 'qwen',
  vision: 'unsupported',
};

describe('useAssistantModelPickerConfig', () => {
  it('builds grouped provider config and picker models from enabled LLM definitions', () => {
    const getProviderLlmModels = vi.fn((provider) => {
      if (provider === 'openrouter') {
        return [gatewayModel];
      }
      return [openAiDefaultModel, openAiDisabledModel];
    });
    const isModelEnabled = vi.fn((_providerId, modelId) =>
      ['hosted-default', 'vendor/uncatalogued'].includes(modelId)
    );

    const { result } = renderHook(() =>
      useAssistantModelPickerConfig({
        configuredProviders: ['openai', 'openrouter'],
        getProviderLlmModels,
        isModelEnabled,
      })
    );

    expect(result.current.providerGroups).toEqual([
      {
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              streaming: true,
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
                vendor: { id: 'openai', name: 'OpenAI' },
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
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              streaming: true,
            }),
            id: 'openrouter',
            models: [
              {
                default: false,
                enabled: true,
                id: 'vendor/uncatalogued',
                label: 'Uncatalogued',
                supportsStreaming: true,
                type: 'llm',
                // The gateway's row names its maker, which its route doesn't.
                vendor: { id: 'qwen', name: 'Qwen' },
              },
            ],
            name: 'OpenRouter',
            runtime: 'gateway',
          }),
        ],
        runtime: 'gateway',
      },
    ]);
    expect(result.current.pickerModels).toEqual([
      // Hosted OpenAI models reason by provider default.
      {
        capabilities: { reasoning: 'supported', vision: 'supported' },
        id: 'hosted-default',
        providerId: 'openai',
      },
      // Undeclared gateway models surface reasoning 'unknown' (unverified).
      {
        capabilities: { reasoning: 'unknown', vision: 'unsupported' },
        id: 'vendor/uncatalogued',
        providerId: 'openrouter',
      },
    ]);
  });
});
