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

describe('useAvailableModels', () => {
  it('should filter and transform enabled embedding models', () => {
    const { result } = renderHook(() => useAvailableModels(mockModels));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      id: 'openai::text-embedding-3-small',
      providerId: 'openai',
      name: 'Text Embedding 3 Small',
      description: 'OpenAI model',
      capabilities: { type: 'embedding' },
      pricePer1MTokensInput: 0.02,
    });
    expect(result.current[1]).toEqual({
      id: 'bge-m3', // local doesn't get prefix in this implementation
      providerId: 'local',
      name: 'BGE M3',
      description: 'Local model',
      capabilities: { type: 'embedding' },
    });
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
});
