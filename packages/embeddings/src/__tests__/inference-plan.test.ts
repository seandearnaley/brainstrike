import { describe, expect, it } from 'vitest';
import { resolvePinnedEmbeddingPlan } from '../inference-plan.js';

const fused = {
  device: 'webgpu' as const,
  dimensions: 384,
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
};
const legacy = {
  device: 'wasm' as const,
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
};

describe('explicit pinned embedding request plan', () => {
  it.each([
    [fused, 256],
    [{ ...fused, device: 'wasm' as const, dtype: 'fp32' }, 256],
    [legacy, 512],
    [{ ...legacy, dtype: 'fp32' }, 512],
  ])('resolves only the supplied supported worker plan', (request, tokenCap) => {
    expect(resolvePinnedEmbeddingPlan(request)).toEqual({
      kind: 'ready',
      profile: {
        dimensions: 384,
        dtype: request.dtype,
        modelId: request.modelId,
        revision: request.revision,
        tokenCap,
      },
      workerPlan: request,
    });
  });
  it('does not derive revision, dtype or device from a selected model ID and dimensions', () => {
    expect(resolvePinnedEmbeddingPlan({ dimensions: 384, modelId: legacy.modelId })).toEqual({
      kind: 'unavailable',
      reason: 'The selected embedding request requires an explicit revision, device and dtype.',
    });
  });
  it.each([
    { ...fused, dtype: 'q8' },
    { ...fused, device: 'wasm' as const },
    { ...legacy, dtype: 'q4' },
    { ...legacy, device: 'webgpu' as const },
  ])('refuses unsupported device/dtype without changing the request', (request) => {
    const before = structuredClone(request);
    expect(resolvePinnedEmbeddingPlan(request)).toEqual({
      kind: 'unavailable',
      reason:
        'The selected pinned embedding export does not support this validated device/dtype profile.',
    });
    expect(request).toEqual(before);
  });
  it.each([
    { ...fused, revision: 'main' },
    { ...fused, revision: legacy.revision },
    { ...fused, dimensions: 768 },
    { ...fused, modelId: 'arbitrary/model' },
  ])('refuses unverified export identity without substituting a model', (request) => {
    expect(resolvePinnedEmbeddingPlan(request)).toEqual({
      kind: 'unavailable',
      reason:
        'The selected embedding export revision and dimensions are not a validated native vector profile.',
    });
  });
});
