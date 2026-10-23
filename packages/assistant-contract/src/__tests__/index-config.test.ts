import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_CONFIG,
  decodeIndexConfig,
  decodeIndexLocalExecution,
  indexModelId,
  indexModelLocalSelection,
  sameIndexChunking,
  sameIndexModel,
} from '../index-config.js';

const semantic = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: {
    dimensions: 768,
    local: {
      device: 'webgpu',
      dtype: 'fp16',
      revision: '0123456789abcdef0123456789abcdef01234567',
    },
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
      { ...semantic, model: { ...semantic.model, modelKey: 'bge-small' } },
      '["model"]["modelKey"]',
    ],
    [
      'a local revision that is not a commit SHA',
      {
        ...semantic,
        model: { ...semantic.model, local: { ...semantic.model.local, revision: 'main' } },
      },
      '["model"]["local"]["revision"]',
    ],
    [
      'a local dtype no executor runs',
      {
        ...semantic,
        model: { ...semantic.model, local: { ...semantic.model.local, dtype: 'int8' } },
      },
      '["model"]["local"]["dtype"]',
    ],
    ['an unknown field', { ...DEFAULT_INDEX_CONFIG, collection: 'x' }, '["collection"]'],
  ])('refuses %s', (_label, input, path) => {
    expect(() => decodeIndexConfig(input)).toThrow(`at ${path}`);
  });

  it('decodes a local execution plan with the config rule', () => {
    expect(decodeIndexLocalExecution({ device: 'wasm', dtype: 'q8' })).toEqual({
      device: 'wasm',
      dtype: 'q8',
    });
    expect(() => decodeIndexLocalExecution({ device: 'wasm', dtype: 'int8' })).toThrow(
      'at ["dtype"]'
    );
  });

  it('names the on-device execution the index runs a local model with', () => {
    expect(indexModelLocalSelection(semantic.model)).toEqual({
      device: 'webgpu',
      dimensions: 768,
      dtype: 'fp16',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      revision: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(indexModelLocalSelection({ ...semantic.model, local: null })).toBeNull();
  });

  it('refuses to name a model whose key has no provider', () => {
    expect(() => indexModelId({ modelKey: 'bge-small' })).toThrow(
      'Embedding model key "bge-small" names no provider.'
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

  it('compares models by value, including how a local model runs', () => {
    expect(
      sameIndexModel(semantic.model, { ...semantic.model, local: { ...semantic.model.local } })
    ).toBe(true);
    expect(sameIndexModel(semantic.model, { ...semantic.model, local: null })).toBe(false);
  });
});
