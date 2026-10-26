import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmbeddingInputHash, isEmbeddingInputHash } from '../embedding-input-hash.js';

describe('embedding input hash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hashes the content/model identity with the durable payload algorithm', async () => {
    await expect(buildEmbeddingInputHash('hash-1', 'openai::text-embedding-3-small')).resolves.toBe(
      'cc48e54faf852e887cf52ea4b232e7c3db4773e5a55c0045e9ee06a8b4151b78'
    );
  });

  it('rejects missing identity inputs', async () => {
    await expect(buildEmbeddingInputHash('', 'openai::text-embedding-3-small')).rejects.toThrow(
      'without a content hash'
    );
    await expect(buildEmbeddingInputHash('hash-1', '')).rejects.toThrow('without a model key');
  });

  it('fails visibly when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);

    await expect(
      buildEmbeddingInputHash('hash-1', 'openai::text-embedding-3-small')
    ).rejects.toThrow('requires crypto.subtle.digest');
  });

  it('rejects an invalid SHA-256 digest length', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new ArrayBuffer(16)),
      },
    });

    await expect(
      buildEmbeddingInputHash('hash-1', 'openai::text-embedding-3-small')
    ).rejects.toThrow('invalid 16-byte embedding input hash');
  });

  it('accepts only canonical lowercase SHA-256 text', () => {
    expect(
      isEmbeddingInputHash('cc48e54faf852e887cf52ea4b232e7c3db4773e5a55c0045e9ee06a8b4151b78')
    ).toBe(true);
    expect(
      isEmbeddingInputHash('CC48E54FAF852E887CF52EA4B232E7C3DB4773E5A55C0045E9EE06A8B4151B78')
    ).toBe(false);
    expect(isEmbeddingInputHash('not-a-hash')).toBe(false);
  });
});
