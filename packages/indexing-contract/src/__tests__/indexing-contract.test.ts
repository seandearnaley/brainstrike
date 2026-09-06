import { describe, expect, it } from 'vitest';
import {
  assertEmbedWorkerLifetimeError,
  assertEmbedWorkerRequestControl,
  buildEmbeddingJobInputHashes,
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
  it('validates graceful workerpool request-control messages', () => {
    expect(() =>
      assertEmbedWorkerRequestControl({ id: 'task-1', type: 'cancel-request' })
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerRequestControl({ id: 'task-1', type: 'clear-request-control' })
    ).not.toThrow();
    expect(() => assertEmbedWorkerRequestControl({ id: '', type: 'cancel-request' })).toThrow(
      'Embedding worker request-control event requires a request id.'
    );
  });

  it('hashes job inputs against the worker-resolved hosted model key', async () => {
    await expect(
      buildEmbeddingJobInputHashes(['hash-1'], 'text-embedding-3-small', 'openai')
    ).resolves.toEqual(['cc48e54faf852e887cf52ea4b232e7c3db4773e5a55c0045e9ee06a8b4151b78']);
  });

  it('validates worker-lifetime errors used for idle pool replacement', () => {
    expect(() =>
      assertEmbedWorkerLifetimeError({
        cause: 'stack',
        message: 'Worker unhandled rejection: idle rejection',
        type: 'worker-lifetime-error',
        workerInstanceId: 'worker-1',
      })
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerLifetimeError({
        message: '',
        type: 'worker-lifetime-error',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('Embedding worker lifetime-error event requires a message.');
  });

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
