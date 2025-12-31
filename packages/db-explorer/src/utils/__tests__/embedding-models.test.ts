import type { DbModel } from '@brainstrike/preferences';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  buildLocalEmbeddingModelConfigMap,
  getDefaultLocalEmbeddingModel,
  getEmbeddingsPanelModels,
  getLocalEmbeddingModels,
  isEmbeddingModel,
  isLocalProviderId,
  resolveEmbeddingSetModelInfo,
  toEmbeddingModelConfig,
} from '../embedding-models';

const baseModel: DbModel = {
  id: 'jinaai/jina-embeddings-v3',
  providerId: 'transformers',
  name: 'Jina V3',
  description: 'Code embeddings',
  tagline: null,
  bestFor: ['code', 'default'],
  icon: null,
  isEnabled: true,
  capabilities: { type: 'embedding', defaultDimension: 768 },
  parameters: { size: '~300MB', contextWindow: 8192 },
  sortOrder: 1,
};

function makeModel(overrides: Partial<DbModel> = {}): DbModel {
  return {
    ...baseModel,
    ...overrides,
    capabilities: {
      ...baseModel.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    parameters: overrides.parameters ?? baseModel.parameters,
    bestFor: overrides.bestFor ?? baseModel.bestFor,
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
  });

  it('maps DbModel to ModelConfig with metadata', () => {
    const model = makeModel({
      description: null,
      tagline: 'Fast embeddings',
      parameters: { size: 256, contextWindow: '4096' },
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
      makeModel({ id: 'llm', capabilities: { type: 'llm' }, sortOrder: 3 }),
      makeModel({ id: 'local-1', providerId: 'transformers', sortOrder: 0 }),
    ];

    const local = getLocalEmbeddingModels(models);
    expect(local.map((model) => model.id)).toEqual(['local-1', 'local-2']);
  });

  it('prefers enabled local models for embeddings panel', () => {
    const models = [
      makeModel({ id: 'disabled', isEnabled: false, sortOrder: 0 }),
      makeModel({ id: 'enabled', isEnabled: true, sortOrder: 1 }),
    ];

    const panel = getEmbeddingsPanelModels(models);
    expect(panel.map((model) => model.id)).toEqual(['enabled']);
  });

  it('returns no models when none are enabled', () => {
    const models = [
      makeModel({ id: 'disabled-1', isEnabled: false, sortOrder: 0 }),
      makeModel({ id: 'disabled-2', isEnabled: false, sortOrder: 1 }),
    ];

    const panel = getEmbeddingsPanelModels(models);
    expect(panel).toEqual([]);
  });

  it('selects the default local embedding model', () => {
    const models = [
      makeModel({ id: 'secondary', sortOrder: 2 }),
      makeModel({ id: 'primary', sortOrder: 0, isEnabled: true }),
    ];

    const defaultModel = getDefaultLocalEmbeddingModel(models);
    expect(defaultModel?.id).toBe('primary');
  });

  it('builds a config map for local embedding models', () => {
    const models = [
      makeModel({ id: 'local', providerId: 'local', sortOrder: 0 }),
      makeModel({ id: 'hosted', providerId: 'openai', sortOrder: 1 }),
      makeModel({ id: 'disabled', providerId: 'local', isEnabled: false, sortOrder: 2 }),
    ];

    const map = buildLocalEmbeddingModelConfigMap(models);
    expect(map.size).toBe(1);
    expect(map.has('disabled')).toBe(false);
    expect(map.get('local')?.dimensions).toBe(768);
  });

  it('resolves hosted model info without local config', () => {
    const result = resolveEmbeddingSetModelInfo(
      { modelKey: 'openai::text-embedding-3-small', dimensions: 1536 },
      new Map()
    );

    expect(result.modelKey).toBe('openai::text-embedding-3-small');
    expect(result.dimensions).toBe(1536);
    expect(result.modelConfig).toBeUndefined();
  });

  it('resolves local model info with registry config', () => {
    const model = makeModel({ id: 'local-embed', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    const result = resolveEmbeddingSetModelInfo({ modelKey: 'local-embed', dimensions: 768 }, map);

    expect(result.modelKey).toBe('local-embed');
    expect(result.dimensions).toBe(768);
    expect(result.modelConfig?.id).toBe('local-embed');
  });

  it('throws when model key is missing or invalid', () => {
    const map = new Map();
    expect(() => resolveEmbeddingSetModelInfo({ modelKey: '  ', dimensions: 768 }, map)).toThrow(
      'Embedding set has invalid model key.'
    );
  });

  it('throws when dimensions are invalid', () => {
    const map = new Map();
    expect(() => resolveEmbeddingSetModelInfo({ modelKey: 'local', dimensions: 0 }, map)).toThrow(
      'Embedding set dimensions are missing or invalid.'
    );
  });

  it('throws when local model is unknown with available list', () => {
    const model = makeModel({ id: 'known', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    expect(() =>
      resolveEmbeddingSetModelInfo({ modelKey: 'missing', dimensions: 768 }, map)
    ).toThrow(/Available models: known/iu);
  });

  it('throws when local dimensions do not match', () => {
    const model = makeModel({ id: 'local', providerId: 'transformers' });
    const map = buildLocalEmbeddingModelConfigMap([model]);

    expect(() =>
      resolveEmbeddingSetModelInfo({ modelKey: 'local', dimensions: 1024 }, map)
    ).toThrow(/Embedding set dimensions \(1024\) do not match registry \(768\)/u);
  });
});
