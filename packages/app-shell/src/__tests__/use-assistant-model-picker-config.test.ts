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
  tagline: 'Most capable for everyday work',
  type: 'llm',
  vision: 'supported',
};

const openAiDisabledModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'hosted-disabled',
  label: 'Hosted Disabled',
  supportsStreaming: true,
  type: 'llm',
  vision: 'unsupported',
};

const gatewayModel: LlmProviderModelDefinition = {
  contextWindow: 200_000,
  id: 'vendor/uncatalogued',
  label: 'Uncatalogued',
  supportsStreaming: true,
  type: 'llm',
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
        label: 'Hosted',
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              llm: true,
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
        label: 'Gateway',
        providers: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              llm: true,
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
              },
            ],
            name: 'OpenRouter',
            runtime: 'gateway',
          }),
        ],
        runtime: 'gateway',
      },
    ]);
    expect(result.current.pickerProviders).toEqual([
      { icon: null, id: 'openai', name: 'OpenAI' },
      { icon: null, id: 'openrouter', name: 'OpenRouter' },
    ]);
    expect(result.current.pickerModels).toEqual([
      {
        // Hosted OpenAI models reason by provider default; the tagline flows
        // through as the row description.
        capabilities: {
          reasoning: 'supported',
          streaming: true,
          type: 'llm',
          vision: 'supported',
        },
        contextWindow: 200_000,
        description: 'Most capable for everyday work',
        id: 'hosted-default',
        name: 'Hosted Default',
        providerId: 'openai',
      },
      {
        // Undeclared gateway models surface reasoning 'unknown' (unverified),
        // and taglineless models keep a null description (no invented copy).
        capabilities: {
          reasoning: 'unknown',
          streaming: true,
          type: 'llm',
          vision: 'unsupported',
        },
        contextWindow: 200_000,
        description: null,
        id: 'vendor/uncatalogued',
        name: 'Uncatalogued',
        providerId: 'openrouter',
      },
    ]);
  });
});
