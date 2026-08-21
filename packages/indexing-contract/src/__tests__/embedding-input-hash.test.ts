import { describe, expect, it } from 'vitest';
import { buildEmbeddingInputHash, isEmbeddingInputHash } from '../embedding-input-hash.js';

describe('embedding input hash', () => {
  it('hashes the content/model identity with the durable payload algorithm', async () => {
    await expect(buildEmbeddingInputHash('hash-1', 'local::bge-m3')).resolves.toBe(
      'a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df'
    );
  });

  it('rejects missing identity inputs', async () => {
    await expect(buildEmbeddingInputHash('', 'local::bge-m3')).rejects.toThrow(
      'without a content hash'
    );
    await expect(buildEmbeddingInputHash('hash-1', '')).rejects.toThrow('without a model key');
  });

  it('accepts only canonical lowercase SHA-256 text', () => {
    expect(
      isEmbeddingInputHash('a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df')
    ).toBe(true);
    expect(
      isEmbeddingInputHash('A80AABF0D21D49164154D0972531EDF40605EB595AFF029C37BC74CA083A98DF')
    ).toBe(false);
    expect(isEmbeddingInputHash('not-a-hash')).toBe(false);
  });
});
