import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_CONFIG,
  decodeIndexConfig,
  indexModelId,
  sameIndexChunking,
  sameIndexModel,
} from '../index-config.js';

const semantic = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: {
    dimensions: 1536,
    modelKey: 'openai::text-embedding-3-small',
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

  it('accepts the largest custom chunk size and overlap', () => {
    const chunking = { _tag: 'Custom', maxTokens: 2048, overlap: 256 } as const;
    expect(decodeIndexConfig({ ...DEFAULT_INDEX_CONFIG, chunking }).chunking).toEqual(chunking);
  });

  it.each([
    ['a chunk size above 2048', { _tag: 'Custom', maxTokens: 4096, overlap: 64 }, 'maxTokens'],
    ['a chunk size below 128', { _tag: 'Custom', maxTokens: 64, overlap: 0 }, 'maxTokens'],
    ['an overlap above 256', { _tag: 'Custom', maxTokens: 512, overlap: 512 }, 'overlap'],
  ])('refuses %s', (_label, chunking, field) => {
    expect(() => decodeIndexConfig({ ...DEFAULT_INDEX_CONFIG, chunking })).toThrow(
      `at ["chunking"]["${field}"]`
    );
  });

  it.each([
    [
      'a model key without its provider',
      { ...semantic, model: { ...semantic.model, modelKey: 'text-embedding-3-small' } },
      '["model"]["modelKey"]',
    ],
    ['an unknown field', { ...DEFAULT_INDEX_CONFIG, collection: 'x' }, '["collection"]'],
  ])('refuses %s', (_label, input, path) => {
    expect(() => decodeIndexConfig(input)).toThrow(`at ${path}`);
  });

  it('names the model a key carries', () => {
    expect(indexModelId(semantic.model)).toBe('text-embedding-3-small');
  });

  it('refuses to name a model whose key has no provider', () => {
    expect(() => indexModelId({ modelKey: 'text-embedding-3-small' })).toThrow(
      'Embedding model key "text-embedding-3-small" names no provider.'
    );
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

  it('compares models by value', () => {
    expect(sameIndexModel(semantic.model, { ...semantic.model })).toBe(true);
    expect(sameIndexModel(semantic.model, { ...semantic.model, dimensions: 512 })).toBe(false);
  });
});
