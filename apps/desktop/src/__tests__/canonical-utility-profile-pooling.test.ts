// @vitest-environment node
import { vectorProfileHash } from '@brainstrike/indexer';
import { describe, expect, it } from 'vitest';
import { decode, vectorProfileSchema } from '../canonical-utility-protocol';

const granite = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  pooling: 'cls',
  provider: 'local',
  revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8',
} as const;

describe('canonical utility profile boundary (BST-1993)', () => {
  it('carries a CLS profile across the utility boundary with its identity intact', () => {
    const decoded = decode(vectorProfileSchema)(granite);
    expect(decoded).toEqual(granite);
    expect(vectorProfileHash(decoded)).toBe(vectorProfileHash(granite));
  });

  it('refuses pooling on a hosted profile and an unknown pooling', () => {
    expect(() =>
      decode(vectorProfileSchema)({
        dimensions: 768,
        distance: 'cosine',
        modelId: 'gemini-embedding-2',
        pooling: 'cls',
        provider: 'google',
      })
    ).toThrow();
    expect(() => decode(vectorProfileSchema)({ ...granite, pooling: 'max' })).toThrow();
  });
});
