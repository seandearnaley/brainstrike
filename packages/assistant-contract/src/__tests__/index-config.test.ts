import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_CONFIG,
  decodeIndexConfig,
  indexModelLocalSelection,
  sameIndexChunking,
} from '../index-config.js';

const semantic = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: {
    dimensions: 768,
    local: { device: 'webgpu', dtype: 'fp16' },
    modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
  },
} as const;

describe('index config', () => {
  it('starts a fresh profile on text search with automatic chunking', () => {
    expect(decodeIndexConfig(DEFAULT_INDEX_CONFIG)).toEqual({
      chunking: { _tag: 'Auto' },
      mode: 'text',
      model: null,
      paused: false,
      policy: 'balanced',
      worktrees: {},
    });
  });

  it('keeps a semantic choice with its model', () => {
    expect(decodeIndexConfig(semantic)).toEqual(semantic);
  });

  it('refuses semantic search without a model', () => {
    expect(() => decodeIndexConfig({ ...DEFAULT_INDEX_CONFIG, mode: 'semantic' })).toThrow(
      'Semantic search needs an embedding model'
    );
  });

  it.each([
    ['a chunk size above 2048', { _tag: 'Custom', maxTokens: 4096, overlap: 64 }],
    ['a chunk size below 128', { _tag: 'Custom', maxTokens: 64, overlap: 0 }],
    ['an overlap above 256', { _tag: 'Custom', maxTokens: 512, overlap: 512 }],
  ])('refuses %s', (_label, chunking) => {
    expect(() => decodeIndexConfig({ ...DEFAULT_INDEX_CONFIG, chunking })).toThrow();
  });

  it('refuses a model key without its provider and any unknown field', () => {
    expect(() =>
      decodeIndexConfig({ ...semantic, model: { ...semantic.model, modelKey: 'bge-small' } })
    ).toThrow();
    expect(() => decodeIndexConfig({ ...DEFAULT_INDEX_CONFIG, collection: 'x' })).toThrow();
  });

  it('names the on-device execution the index runs a local model with', () => {
    expect(indexModelLocalSelection(semantic.model)).toEqual({
      device: 'webgpu',
      dimensions: 768,
      dtype: 'fp16',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
    });
    expect(indexModelLocalSelection({ ...semantic.model, local: null })).toBeNull();
  });

  it('compares chunking by value', () => {
    expect(
      sameIndexChunking(
        { _tag: 'Custom', maxTokens: 512, overlap: 64 },
        { _tag: 'Custom', maxTokens: 512, overlap: 64 }
      )
    ).toBe(true);
    expect(
      sameIndexChunking({ _tag: 'Auto' }, { _tag: 'Custom', maxTokens: 512, overlap: 64 })
    ).toBe(false);
  });
});
