import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmbeddingInputHash, isEmbeddingInputHash } from '../embedding-input-hash.js';

describe('embedding input hash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('fails visibly when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);

    await expect(buildEmbeddingInputHash('hash-1', 'local::bge-m3')).rejects.toThrow(
      'requires crypto.subtle.digest'
    );
  });

  it('rejects an invalid SHA-256 digest length', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new ArrayBuffer(16)),
      },
    });

    await expect(buildEmbeddingInputHash('hash-1', 'local::bge-m3')).rejects.toThrow(
      'invalid 16-byte embedding input hash'
    );
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
