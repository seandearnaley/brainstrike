import type { DbModel } from '@brainstrike/preferences';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  buildLocalEmbeddingModelConfigMap,
  getLocalEmbeddingModels,
  isEmbeddingModel,
  isLocalProviderId,
  resolveEmbeddingSetModelInfo,
  toEmbeddingModelConfig,
} from '../embedding-models';

const baseModel: DbModel = {
  bestFor: ['code', 'default'],
  capabilities: { defaultDimension: 768, type: 'embedding' },
  description: 'Code embeddings',
  icon: null,
  id: 'jinaai/jina-embeddings-v3',
  isEnabled: true,
  name: 'Jina V3',
  parameters: { contextWindow: 8192, size: '~300MB' },
  providerId: 'transformers',
  sortOrder: 1,
  tagline: null,
};

function makeModel(overrides: Partial<DbModel> = {}): DbModel {
  return {
    ...baseModel,
    ...overrides,
    bestFor: overrides.bestFor ?? baseModel.bestFor,
    capabilities: {
      ...baseModel.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    parameters: overrides.parameters ?? baseModel.parameters,
  };
}

describe('embedding-models utilities', () => {
  it('recognizes local providers', () => {
    expect(isLocalProviderId('local')).toBe(true);
    expect(isLocalProviderId('transformers')).toBe(true);
    expect(isLocalProviderId('openai')).toBe(false);
  });

  it('filters embedding models by capabilities', () => {
    expect(isEmbeddingModel(makeModel())).toBe(true);
    expect(isEmbeddingModel(makeModel({ capabilities: { type: 'llm' } }))).toBe(false);
    expect(
      isEmbeddingModel({ ...makeModel(), capabilities: undefined } as unknown as DbModel)
    ).toBe(false);
  });

  it('maps DbModel to ModelConfig with metadata', () => {
    const model = makeModel({
      description: null,
      parameters: { contextWindow: '4096', size: 256 },
      tagline: 'Fast embeddings',
    });
    const config = toEmbeddingModelConfig(model);

    expect(config.id).toBe(model.id);
    expect(config.name).toBe(model.name);
    expect(config.dimensions).toBe(768);
    expect(config.description).toBe('Fast embeddings');
    expect(config.tags).toEqual(['code', 'default']);
    expect(config.origin).toBe('transformers');
    expect(config.size).toBe('256');
    expect(config.contextWindow).toBe(4096);
  });

  it('reads quantized flag from parameters', () => {
    const model = makeModel({
      parameters: { ...(baseModel.parameters ?? {}), quantized: true },
    });
    const config = toEmbeddingModelConfig(model);

    expect(config.quantized).toBe(true);
  });

  it('uses default dimension when missing', () => {
    const model = makeModel({
      capabilities: { type: 'embedding' },
    });
    const config = toEmbeddingModelConfig(model);
    expect(config.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
  });

  it('returns sorted local embedding models only', () => {
    const models = [
      makeModel({ id: 'local-2', providerId: 'local', sortOrder: 2 }),
      makeModel({ id: 'hosted', providerId: 'openai', sortOrder: 1 }),
      makeModel({ capabilities: { type: 'llm' }, id: 'llm', sortOrder: 3 }),
      makeModel({ id: 'local-1', providerId: 'transformers', sortOrder: 0 }),
    ];

    const local = getLocalEmbeddingModels(models);
    expect(local.map((model) => model.id)).toEqual(['local-1', 'local-2']);
  });

  it('builds a config map for local embedding models', () => {
    const models = [
      makeModel({ id: 'local', providerId: 'local', sortOrder: 0 }),
      makeModel({ id: 'hosted', providerId: 'openai', sortOrder: 1 }),
      makeModel({ id: 'disabled', isEnabled: false, providerId: 'local', sortOrder: 2 }),
    ];

    const map = buildLocalEmbeddingModelConfigMap(models);
    expect(map.size).toBe(1);
    expect(map.has('disabled')).toBe(false);
    expect(map.get('local')?.dimensions).toBe(768);
  });

  it('ignores malformed models when building local config map', () => {
    const malformed = {
      ...makeModel(),
      capabilities: undefined,
      id: 'broken',
    } as unknown as DbModel;
    const valid = makeModel({ id: 'valid-local', providerId: 'local' });

    const map = buildLocalEmbeddingModelConfigMap([malformed, valid]);

    expect(map.size).toBe(1);
    expect(map.has('broken')).toBe(false);
    expect(map.has('valid-local')).toBe(true);
  });

  it('resolves hosted model info without local config', () => {
    const result = resolveEmbeddingSetModelInfo(
      { dimensions: 1536, modelKey: 'openai::text-embedding-3-small' },
      new Map()
    );

    expect(result.modelKey).toBe('openai::text-embedding-3-small');
    expect(result.dimensions).toBe(1536);
    expect(result.modelConfig).toBeUndefined();
  });

  it('resolves local model info with registry config', () => {
    const model = makeModel({ id: 'local-embed', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    const result = resolveEmbeddingSetModelInfo({ dimensions: 768, modelKey: 'local-embed' }, map);

    expect(result.modelKey).toBe('local-embed');
    expect(result.dimensions).toBe(768);
    expect(result.modelConfig?.id).toBe('local-embed');
  });

  it('throws when model key is missing or invalid', () => {
    const map = new Map();
    expect(() => resolveEmbeddingSetModelInfo({ dimensions: 768, modelKey: '  ' }, map)).toThrow(
      'Embedding set has invalid model key.'
    );
  });

  it('throws when dimensions are invalid', () => {
    const map = new Map();
    expect(() => resolveEmbeddingSetModelInfo({ dimensions: 0, modelKey: 'local' }, map)).toThrow(
      'Embedding set dimensions are missing or invalid.'
    );
  });

  it('throws when dimensions are NaN or infinite', () => {
    const map = new Map();
    expect(() =>
      resolveEmbeddingSetModelInfo({ dimensions: Number.NaN, modelKey: 'local' }, map)
    ).toThrow('Embedding set dimensions are missing or invalid.');
    expect(() =>
      resolveEmbeddingSetModelInfo({ dimensions: Number.POSITIVE_INFINITY, modelKey: 'local' }, map)
    ).toThrow('Embedding set dimensions are missing or invalid.');
  });

  it('includes empty available list when no models are registered', () => {
    const map = new Map();
    expect(() =>
      resolveEmbeddingSetModelInfo({ dimensions: 768, modelKey: 'missing' }, map)
    ).toThrow(/Available models: none/iu);
  });

  it('throws when local model is unknown with available list', () => {
    const model = makeModel({ id: 'known', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    expect(() =>
      resolveEmbeddingSetModelInfo({ dimensions: 768, modelKey: 'missing' }, map)
    ).toThrow(/Available models: known/iu);
  });

  it('throws when local dimensions do not match', () => {
    const model = makeModel({ id: 'local', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    expect(() =>
      resolveEmbeddingSetModelInfo({ dimensions: 1024, modelKey: 'local' }, map)
    ).toThrow(/Embedding set dimensions \(1024\) do not match registry \(768\)/u);
  });

  it('accepts legacy hosted model keys', () => {
    const result = resolveEmbeddingSetModelInfo(
      { dimensions: 1536, modelKey: 'openai:text-embedding-3-small' },
      new Map()
    );

    expect(result.modelKey).toBe('openai:text-embedding-3-small');
    expect(result.dimensions).toBe(1536);
    expect(result.modelConfig).toBeUndefined();
  });
});
