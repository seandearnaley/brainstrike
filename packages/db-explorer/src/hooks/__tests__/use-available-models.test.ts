import type { LocalRuntimeModelCatalogState } from '@brainstrike/assistant-contract/local-runtime';
import type { DbModel, DbProvider } from '@brainstrike/preferences';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAvailableModels, useAvailableProviders } from '../use-available-models';

const mockModels: DbModel[] = [
  {
    bestFor: null,
    capabilities: { type: 'embedding' },
    description: 'OpenAI model',
    icon: null,
    id: 'text-embedding-3-small',
    isEnabled: true,
    name: 'Text Embedding 3 Small',
    parameters: { pricePer1MTokens: 0.02 },
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { type: 'embedding' },
    description: 'Local model',
    icon: null,
    id: 'bge-m3',
    isEnabled: true,
    name: 'BGE M3',
    parameters: {},
    providerId: 'local',
    sortOrder: 1,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { type: 'embedding' },
    description: '',
    icon: null,
    id: 'disabled-model',
    isEnabled: false,
    name: 'Disabled',
    parameters: {},
    providerId: 'openai',
    sortOrder: 2,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { type: 'chat' } as any,
    description: '',
    icon: null,
    id: 'chat-model',
    isEnabled: true,
    name: 'Chat',
    parameters: {},
    providerId: 'openai',
    sortOrder: 3,
    tagline: null,
  },
];

const mockProviders: DbProvider[] = [
  {
    icon: 'openai-icon',
    id: 'openai',
    isEnabled: true,
    name: 'OpenAI',
    sortOrder: 0,
  },
  {
    icon: null,
    id: 'disabled-provider',
    isEnabled: false,
    name: 'Disabled',
    sortOrder: 1,
  },
];

const runtimeCatalog: {
  ollama: LocalRuntimeModelCatalogState;
  lmstudio: LocalRuntimeModelCatalogState;
} = {
  lmstudio: {
    availability: {
      checkedAt: 100,
      message: 'Connection refused',
      state: 'unavailable',
    },
    checkedAt: 100,
    message: 'Connection refused',
    runtime: 'lmstudio',
    state: 'failed',
  },
  ollama: {
    availability: {
      checkedAt: 100,
      endpoint: 'http://127.0.0.1:11434/v1/models',
      latencyMs: 8,
      state: 'available',
    },
    checkedAt: 100,
    endpoint: 'http://127.0.0.1:11434/v1/models',
    freshness: 'live',
    models: [
      {
        capabilities: {
          embeddings: 'supported',
          llm: false,
          vision: 'unknown',
        },
        capabilitySource: 'inferred',
        dimensionsKnown: {
          endpoint: 'http://127.0.0.1:11434/v1/embeddings',
          state: 'known',
          values: [768],
          verifiedAt: 99,
        },
        displayName: 'Nomic Embed Text',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'live',
        modelId: 'nomic-embed-text',
        modelKey: 'ollama::nomic-embed-text',
        providerId: 'ollama',
        runtime: 'ollama',
        source: 'openai_v1_models',
      },
      {
        capabilities: {
          embeddings: 'needs_verification',
          llm: true,
          vision: 'unknown',
        },
        capabilitySource: 'inferred',
        dimensionsKnown: {
          state: 'needs_verification',
        },
        displayName: 'qwen2.5:7b',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'live',
        modelId: 'qwen2.5:7b',
        modelKey: 'ollama::qwen2.5:7b',
        providerId: 'ollama',
        runtime: 'ollama',
        source: 'openai_v1_models',
      },
    ],
    runtime: 'ollama',
    source: 'openai_v1_models',
    state: 'loaded_non_empty',
  },
};

describe('useAvailableModels', () => {
  it('should filter and transform enabled embedding models', () => {
    const { result } = renderHook(() => useAvailableModels(mockModels));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      capabilities: { type: 'embedding' },
      description: 'OpenAI model',
      id: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      name: 'Text Embedding 3 Small',
      pricePer1MTokensInput: 0.02,
      providerId: 'openai',
    });
    expect(result.current[1]).toEqual({
      capabilities: { type: 'embedding' },
      description: 'Local model',
      id: 'local::bge-m3',
      modelId: 'bge-m3',
      name: 'BGE M3',
      providerId: 'local',
    });
  });

  it('should include runtime-discovered models with verified dimensions', () => {
    const { result } = renderHook(() => useAvailableModels(mockModels, runtimeCatalog));

    expect(result.current).toContainEqual({
      capabilities: { defaultDimension: 768, type: 'embedding' },
      description: 'Nomic Embed Text • 768D • Local runtime',
      id: 'ollama::nomic-embed-text',
      modelId: 'nomic-embed-text',
      name: 'nomic-embed-text',
      providerId: 'ollama',
    });
    expect(result.current.some((model) => model.id === 'ollama::qwen2.5:7b')).toBe(false);
  });
});

describe('useAvailableProviders', () => {
  it('should filter enabled providers', () => {
    const { result } = renderHook(() => useAvailableProviders(mockProviders));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toEqual({
      icon: 'openai-icon',
      id: 'openai',
      name: 'OpenAI',
    });
  });

  it('should append runtime providers when runtime embedding models are discovered', () => {
    const { result } = renderHook(() => useAvailableProviders(mockProviders, runtimeCatalog));

    expect(result.current).toContainEqual({
      icon: null,
      id: 'ollama',
      name: 'Ollama',
    });
    expect(result.current.some((provider) => provider.id === 'lmstudio')).toBe(false);
  });
});
