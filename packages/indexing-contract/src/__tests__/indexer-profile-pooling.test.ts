import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type IndexerEmbeddingProfile,
  indexerEmbeddingProfileValues,
  validIndexerEmbeddingProfile,
} from '../indexer-client.js';

const local: IndexerEmbeddingProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  provider: 'local',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
};
// The native vectorProfileHash values, pinned in packages/indexer's pooling identity test.
const MEAN_VECTOR_HASH = '654bee3466feeb474f0f1827badb57d458a679001b339ef3ab959eadbd2b6443';
const CLS_VECTOR_HASH = 'aa79cbf43c5b8b62c9ae6d0838fadc9e75a462c7f7a6e7bc7e20299cfc2d7b75';
const hash = (profile: IndexerEmbeddingProfile): string =>
  createHash('sha256')
    .update(JSON.stringify(indexerEmbeddingProfileValues(profile)))
    .digest('hex');

describe('browser profile identity mirrors native pooling (BST-1993)', () => {
  it('hashes CLS like the native identity, and mean or absent as one identity', () => {
    expect(hash({ ...local, pooling: 'cls' })).toBe(CLS_VECTOR_HASH);
    expect(hash(local)).toBe(MEAN_VECTOR_HASH);
    expect(hash({ ...local, pooling: 'mean' })).toBe(MEAN_VECTOR_HASH);
  });

  it('accepts pooling only on a local profile', () => {
    expect(validIndexerEmbeddingProfile({ ...local, pooling: 'cls' })).toBe(true);
    expect(
      validIndexerEmbeddingProfile({
        dimensions: 768,
        distance: 'cosine',
        modelId: 'gemini-embedding-2',
        pooling: 'cls',
        provider: 'google',
      })
    ).toBe(false);
    expect(
      validIndexerEmbeddingProfile({
        ...local,
        pooling: 'max' as NonNullable<IndexerEmbeddingProfile['pooling']>,
      })
    ).toBe(false);
  });
});
