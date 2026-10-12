import { describe, expect, it } from 'vitest';
import { resolveCatalogEmbeddingPlan } from '../inference-plan.js';

// Existing migrated catalog entries; no new export or revision is introduced.
const bge = { dimensions: 768, id: 'Xenova/bge-base-en-v1.5' };
const selection = { device: 'webgpu' as const, dimensions: 768, dtype: 'fp32', modelId: bge.id };

describe('existing catalog execution parity', () => {
  it('preserves BGE dimensions and an absent revision without substitution', () => {
    expect(resolveCatalogEmbeddingPlan(selection, bge)).toEqual({
      kind: 'ready',
      profile: { dimensions: 768, dtype: 'fp32', modelId: bge.id },
      workerPlan: selection,
    });
  });
  it('preserves explicit execution and revision choices', () => {
    const chosen = { ...selection, device: 'wasm' as const, dtype: 'q4', revision: 'a'.repeat(40) };
    expect(resolveCatalogEmbeddingPlan(chosen, bge)).toMatchObject({
      kind: 'ready',
      workerPlan: chosen,
    });
  });
  it.each([
    { ...selection, modelId: 'foreign/model' },
    { ...selection, dimensions: 384 },
    { ...selection, dtype: 'unknown' },
    { dimensions: selection.dimensions, dtype: selection.dtype, modelId: selection.modelId },
  ])('refuses mismatched authority or missing execution %#', (chosen) => {
    expect(resolveCatalogEmbeddingPlan(chosen, bge).kind).toBe('unavailable');
  });
});
