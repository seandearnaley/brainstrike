import { describe, expect, it } from 'vitest';
import {
  canonicalizeEmbeddingProviderModelKey,
  formatEmbeddingProviderModelKey,
  getChunkingPreset,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
  hostedProviderRequiresApiKey,
  isChunkingStrategy,
  isHostedProvider,
  isLocalProviderType,
  isResolvedChunkingStrategy,
  parseEmbeddingProviderModelKey,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
} from '../index';

describe('@brainstrike/indexing-contract', () => {
  it('routes auto chunking by file extension', () => {
    expect(resolveChunkingStrategyForFile('src/search/index.ts')).toBe('recursive');
    expect(resolveChunkingStrategyForFile('docs/getting-started.md')).toBe('semantic-markdown');
    expect(resolveChunkingStrategyForFile('schemas/search-response.json')).toBe('json');
    expect(resolveChunkingStrategyForFile('notes/retro.txt')).toBe('sentence');
  });

  it('preserves explicit chunking strategy selections', () => {
    expect(resolveChunkingStrategyForFile('src/search/index.ts', 'markdown')).toBe('markdown');
    expect(
      resolveEffectiveChunkingStrategy({
        isCode: false,
        requested: 'auto',
        resolvedAutoStrategy: 'recursive',
      })
    ).toBe('sentence');
    expect(
      resolveEffectiveChunkingStrategy({
        isCode: true,
        requested: 'json',
        resolvedAutoStrategy: 'recursive',
      })
    ).toBe('json');
  });

  it('exposes stable preset definitions and route previews', () => {
    const presets = getChunkingPresetDefinitions();

    expect(presets.some((preset) => preset.id === 'balanced' && preset.isDefault)).toBe(true);
    expect(getChunkingPreset('codebase').strategy).toBe('auto');
    expect(() => getChunkingPreset('missing' as never)).toThrow(/Unknown chunking preset/);
    expect(
      getChunkingRoutePreview('json').every((preview) => preview.resolvedStrategy === 'json')
    ).toBe(true);
  });

  it('narrows chunking strategy values', () => {
    expect(isResolvedChunkingStrategy('recursive')).toBe(true);
    expect(isResolvedChunkingStrategy('auto')).toBe(false);
    expect(isChunkingStrategy('auto')).toBe(true);
    expect(isChunkingStrategy('unknown')).toBe(false);
  });

  it('formats and parses embedding provider model keys', () => {
    expect(formatEmbeddingProviderModelKey('openai', 'text-embedding-3-small')).toBe(
      'openai::text-embedding-3-small'
    );
    expect(parseEmbeddingProviderModelKey('openai::text-embedding-3-small')).toEqual({
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
    expect(parseEmbeddingProviderModelKey('openai:text-embedding-3-small')).toEqual({
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
    expect(parseEmbeddingProviderModelKey('unknown::model')).toBeNull();
    expect(canonicalizeEmbeddingProviderModelKey('text-embedding-3-small', 'openai')).toEqual({
      composite: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });

  it('classifies local and hosted embedding providers', () => {
    expect(isLocalProviderType('local')).toBe(true);
    expect(isLocalProviderType('openai')).toBe(false);
    expect(isHostedProvider('openai')).toBe(true);
    expect(hostedProviderRequiresApiKey('openai')).toBe(true);
    expect(hostedProviderRequiresApiKey('ollama')).toBe(false);
  });
});
