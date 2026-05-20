import type { LocalRuntimeModelCatalogState } from '@brainstrike/assistant-contract/local-runtime';
import type { DbModel, DbProvider } from '@brainstrike/preferences';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAvailableModels, useAvailableProviders } from '../use-available-models';

const mockModels: DbModel[] = [
  {
    id: 'text-embedding-3-small',
    providerId: 'openai',
    name: 'Text Embedding 3 Small',
    description: 'OpenAI model',
    tagline: null,
    bestFor: null,
    icon: null,
    sortOrder: 0,
    isEnabled: true,
    capabilities: { type: 'embedding' },
    parameters: { pricePer1MTokens: 0.02 },
  },
  {
    id: 'bge-m3',
    providerId: 'local',
    name: 'BGE M3',
    description: 'Local model',
    tagline: null,
    bestFor: null,
    icon: null,
    sortOrder: 1,
    isEnabled: true,
    capabilities: { type: 'embedding' },
    parameters: {},
  },
  {
    id: 'disabled-model',
    providerId: 'openai',
    name: 'Disabled',
    description: '',
    tagline: null,
    bestFor: null,
    icon: null,
    sortOrder: 2,
    isEnabled: false,
    capabilities: { type: 'embedding' },
    parameters: {},
  },
  {
    id: 'chat-model',
    providerId: 'openai',
    name: 'Chat',
    description: '',
    tagline: null,
    bestFor: null,
    icon: null,
    sortOrder: 3,
    isEnabled: true,
    capabilities: { type: 'chat' } as any,
    parameters: {},
  },
];

const mockProviders: DbProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    isEnabled: true,
    icon: 'openai-icon',
    sortOrder: 0,
  },
  {
    id: 'disabled-provider',
    name: 'Disabled',
    isEnabled: false,
    icon: null,
    sortOrder: 1,
  },
];

const runtimeCatalog: {
  ollama: LocalRuntimeModelCatalogState;
  lmstudio: LocalRuntimeModelCatalogState;
} = {
  ollama: {
    state: 'loaded_non_empty',
    runtime: 'ollama',
    checkedAt: 100,
    availability: {
      state: 'available',
      checkedAt: 100,
      endpoint: 'http://127.0.0.1:11434/v1/models',
      latencyMs: 8,
    },
    endpoint: 'http://127.0.0.1:11434/v1/models',
    source: 'openai_v1_models',
    freshness: 'live',
    models: [
      {
        runtime: 'ollama',
        providerId: 'ollama',
        modelId: 'nomic-embed-text',
        modelKey: 'ollama::nomic-embed-text',
        displayName: 'Nomic Embed Text',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        source: 'openai_v1_models',
        freshness: 'live',
        capabilities: {
          llm: false,
          embeddings: 'supported',
        },
        capabilitySource: 'inferred',
        dimensionsKnown: {
          state: 'known',
          values: [768],
          verifiedAt: 99,
          endpoint: 'http://127.0.0.1:11434/v1/embeddings',
        },
      },
      {
        runtime: 'ollama',
        providerId: 'ollama',
        modelId: 'qwen2.5:7b',
        modelKey: 'ollama::qwen2.5:7b',
        displayName: 'qwen2.5:7b',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        source: 'openai_v1_models',
        freshness: 'live',
        capabilities: {
          llm: true,
          embeddings: 'needs_verification',
        },
        capabilitySource: 'inferred',
        dimensionsKnown: {
          state: 'needs_verification',
        },
      },
    ],
  },
  lmstudio: {
    state: 'failed',
    runtime: 'lmstudio',
    checkedAt: 100,
    availability: {
      state: 'unavailable',
      checkedAt: 100,
      message: 'Connection refused',
    },
    message: 'Connection refused',
  },
};

describe('useAvailableModels', () => {
  it('should filter and transform enabled embedding models', () => {
    const { result } = renderHook(() => useAvailableModels(mockModels));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      id: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      providerId: 'openai',
      name: 'Text Embedding 3 Small',
      description: 'OpenAI model',
      capabilities: { type: 'embedding' },
      pricePer1MTokensInput: 0.02,
    });
    expect(result.current[1]).toEqual({
      id: 'local::bge-m3',
      modelId: 'bge-m3',
      providerId: 'local',
      name: 'BGE M3',
      description: 'Local model',
      capabilities: { type: 'embedding' },
    });
  });

  it('should include runtime-discovered models with verified dimensions', () => {
    const { result } = renderHook(() => useAvailableModels(mockModels, runtimeCatalog));

    expect(result.current).toContainEqual({
      id: 'ollama::nomic-embed-text',
      modelId: 'nomic-embed-text',
      providerId: 'ollama',
      name: 'nomic-embed-text',
      description: 'Nomic Embed Text • 768D • Local runtime',
      capabilities: { type: 'embedding', defaultDimension: 768 },
    });
    expect(result.current.some((model) => model.id === 'ollama::qwen2.5:7b')).toBe(false);
  });
});

describe('useAvailableProviders', () => {
  it('should filter enabled providers', () => {
    const { result } = renderHook(() => useAvailableProviders(mockProviders));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toEqual({
      id: 'openai',
      name: 'OpenAI',
      icon: 'openai-icon',
    });
  });

  it('should append runtime providers when runtime embedding models are discovered', () => {
    const { result } = renderHook(() => useAvailableProviders(mockProviders, runtimeCatalog));

    expect(result.current).toContainEqual({
      id: 'ollama',
      name: 'Ollama',
      icon: null,
    });
    expect(result.current.some((provider) => provider.id === 'lmstudio')).toBe(false);
  });
});
