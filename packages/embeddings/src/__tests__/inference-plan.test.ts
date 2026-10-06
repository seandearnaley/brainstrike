import { describe, expect, it } from 'vitest';
import {
  resolveCatalogEmbeddingPlan,
  validateCatalogEmbeddingWorkerPlan,
} from '../inference-plan.js';

// Original migrated catalog metadata; no model aliases, downloads or qualification list.
const catalog = [
  { dimensions: 384, id: 'Xenova/bge-small-en-v1.5' },
  { dimensions: 768, id: 'Xenova/bge-base-en-v1.5' },
  { dimensions: 768, id: 'jinaai/jina-embeddings-v2-base-code' },
];
describe('canonical catalog local plans', () => {
  it.each(catalog)('preserves $id and $dimensions', (model) => {
    const request = {
      device: 'wasm' as const,
      dimensions: model.dimensions,
      dtype: 'q8',
      modelId: model.id,
    };
    expect(resolveCatalogEmbeddingPlan(request, model)).toEqual({
      kind: 'ready',
      profile: { dimensions: model.dimensions, dtype: 'q8', modelId: model.id },
      workerPlan: request,
    });
  });
  it.each(['q4', 'q8', 'fp16', 'fp32'] as const)('preserves explicit %s dtype', (dtype) => {
    const request = { device: 'webgpu' as const, dimensions: 384, dtype, modelId: catalog[0]!.id };
    expect(validateCatalogEmbeddingWorkerPlan(request)).toEqual(request);
  });
  it.each(['main', '', 'a'.repeat(39)])('refuses malformed supplied revision %j', (revision) => {
    expect(() =>
      validateCatalogEmbeddingWorkerPlan({
        device: 'wasm',
        dimensions: 384,
        dtype: 'q8',
        modelId: catalog[0]!.id,
        revision,
      })
    ).toThrow();
  });
  it('never selects an omitted device or dtype', () => {
    expect(
      resolveCatalogEmbeddingPlan({ dimensions: 384, modelId: catalog[0]!.id }, catalog[0]!).kind
    ).toBe('unavailable');
  });
});
