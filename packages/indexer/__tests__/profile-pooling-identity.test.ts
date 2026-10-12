import { embeddingProfileHash, vectorProfileHash } from '@brainstrike/indexer';
import { describe, expect, it } from 'vitest';

const revision = 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f';
const local = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  provider: 'local',
  revision,
} as const;
const legacy = {
  dimensions: 384,
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision,
  tokenCap: 256,
} as const;
// Hashes these profiles had before pooling joined the identity: stores written then keep them.
const MEAN_VECTOR_HASH = '654bee3466feeb474f0f1827badb57d458a679001b339ef3ab959eadbd2b6443';
const HOSTED_VECTOR_HASH = 'f84f844ed3db3388a15b4a3f93a4e6557a54455f9460858d563b201f792120a2';
const MEAN_EMBEDDING_HASH = '60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914';
// The browser mirror (indexing-contract's indexerEmbeddingProfileValues) pins the same value.
const CLS_VECTOR_HASH = 'aa79cbf43c5b8b62c9ae6d0838fadc9e75a462c7f7a6e7bc7e20299cfc2d7b75';

describe('pooling in the vector profile identity (BST-1993)', () => {
  it('gives CLS vectors their own identity, so they never share a collection with mean vectors', () => {
    expect(vectorProfileHash({ ...local, pooling: 'cls' })).toBe(CLS_VECTOR_HASH);
    expect(vectorProfileHash({ ...local, pooling: 'cls' })).not.toBe(vectorProfileHash(local));
    expect(embeddingProfileHash({ ...legacy, pooling: 'cls' })).not.toBe(
      embeddingProfileHash(legacy)
    );
  });

  it('treats absent pooling as mean, the identity every existing profile already has', () => {
    expect(vectorProfileHash(local)).toBe(MEAN_VECTOR_HASH);
    expect(vectorProfileHash({ ...local, pooling: 'mean' })).toBe(MEAN_VECTOR_HASH);
    expect(embeddingProfileHash(legacy)).toBe(MEAN_EMBEDDING_HASH);
    expect(embeddingProfileHash({ ...legacy, pooling: 'mean' })).toBe(MEAN_EMBEDDING_HASH);
    expect(
      vectorProfileHash({
        dimensions: 768,
        distance: 'cosine',
        modelId: 'gemini-embedding-2',
        provider: 'google',
      })
    ).toBe(HOSTED_VECTOR_HASH);
  });

  it('refuses an unknown pooling and a pooling on a hosted profile', () => {
    expect(() => vectorProfileHash({ ...local, pooling: 'max' })).toThrow();
    expect(() => embeddingProfileHash({ ...legacy, pooling: 'max' })).toThrow();
    expect(() =>
      vectorProfileHash({
        dimensions: 768,
        distance: 'cosine',
        modelId: 'gemini-embedding-2',
        pooling: 'cls',
        provider: 'google',
      })
    ).toThrow();
  });
});
