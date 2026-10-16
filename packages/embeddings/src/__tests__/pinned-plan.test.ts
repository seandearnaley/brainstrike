import { describe, expect, it } from 'vitest';
import type { CatalogEmbeddingWorkerPlan } from '../inference-plan.js';
import { assertPinnedPlanResult, pinnedPlanModelConfig } from '../pinned-plan.js';
import type { EmbeddingResult } from '../types.js';

const REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const plan: CatalogEmbeddingWorkerPlan = {
  device: 'wasm',
  dimensions: 3,
  dtype: 'q8',
  modelId: 'Xenova/bge-small-en-v1.5',
  pooling: 'cls',
  revision: REVISION,
};
const result = (change: Partial<EmbeddingResult> = {}): EmbeddingResult => ({
  dimensions: 3,
  embedding: [0.1, 0.2, 0.3],
  model: plan.modelId,
  runtime: {
    device: 'wasm',
    dtype: 'q8',
    fallbackApplied: false,
    pooling: 'cls',
    revision: REVISION,
  },
  ...change,
});
const runtime = (change: Partial<NonNullable<EmbeddingResult['runtime']>>) => ({
  runtime: { ...result().runtime!, ...change },
});

describe('a pinned plan', () => {
  it('loads its own model at its dimensions, with no catalog row', () => {
    expect(pinnedPlanModelConfig(plan)).toEqual({
      description: 'Explicit pinned native inference',
      dimensions: 3,
      id: plan.modelId,
      name: plan.modelId,
      quantized: false,
      tags: ['local', 'embedding'],
    });
  });

  it('accepts a result that ran exactly as the plan states', () => {
    expect(() => assertPinnedPlanResult(plan, result())).not.toThrow();
  });

  it('asks for mean pooling when the plan states none', () => {
    const { pooling: _pooling, ...unpooled } = plan;
    expect(() =>
      assertPinnedPlanResult(unpooled, result(runtime({ pooling: 'mean' })))
    ).not.toThrow();
    expect(() => assertPinnedPlanResult(unpooled, result())).toThrow(/runtime metadata/u);
  });

  const invalidValues: ReadonlyArray<readonly [string, EmbeddingResult]> = [
    ['another model', result({ model: 'other' })],
    ['other dimensions', result({ dimensions: 4 })],
    ['a short vector', result({ embedding: [0.1, 0.2] })],
    ['a non-finite value', result({ embedding: [0.1, Number.NaN, 0.3] })],
  ];
  it.each(invalidValues)('refuses %s', (_case, refused) => {
    expect(() => assertPinnedPlanResult(plan, refused)).toThrow(
      /invalid model, dimensions or vector values/u
    );
  });

  const { runtime: _runtime, ...bare } = result();
  const { revision: _revision, ...unrevised } = result().runtime!;
  const otherExecutions: ReadonlyArray<readonly [string, EmbeddingResult]> = [
    ['no runtime metadata', bare],
    ['another device', result(runtime({ device: 'webgpu' }))],
    ['another dtype', result(runtime({ dtype: 'fp32' }))],
    ['a fallback', result(runtime({ fallbackApplied: true }))],
    ['other pooling', result(runtime({ pooling: 'mean' }))],
    ['another revision', result(runtime({ revision: 'a'.repeat(40) }))],
    ['no revision', result({ runtime: unrevised })],
  ];
  it.each(otherExecutions)('refuses %s', (_case, refused) => {
    expect(() => assertPinnedPlanResult(plan, refused)).toThrow(/runtime metadata/u);
  });
});
