import { describe, expect, it } from 'vitest';
import {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from '../embedding-math';

describe('embedding-math', () => {
  it('computes magnitudes and normalization', () => {
    expect(magnitude([3, 4])).toBe(5);
    const n = normalize([3, 4]);
    expect(n.length).toBe(2);
    // unit length within epsilon
    const len = Math.hypot(n[0]!, n[1]!);
    expect(Math.abs(len - 1)).toBeLessThan(1e-6);
  });

  it('computes dot, cosine, and L2', () => {
    const dot = calculateDotProduct([1, 2, 3], [4, 5, 6]);
    expect(dot.similarity).toBe(32);
    expect(dot.method).toBe('dot_product');
    const cos = calculateCosineSimilarity([1, 0], [0, 1]);
    expect(cos.similarity).toBeCloseTo(0, 5);
    const l2 = calculateL2Distance([1, 2], [1, 5]);
    expect(l2.distance).toBe(3);
    expect(l2.method).toBe('l2');
  });

  it('computes dot product for large finite values that cancel out', () => {
    const dot = calculateDotProduct([1e200, -1e200, 1e200, -1e200], [1, 1, 1, 1]);
    expect(Number.isFinite(dot.similarity)).toBe(true);
    expect(dot.similarity).toBe(0);
  });

  describe.each([
    ['cosine', calculateCosineSimilarity],
    ['L2', calculateL2Distance],
    ['dot', calculateDotProduct],
  ])('%s similarity edge cases', (_name, fn) => {
    it('throws on length mismatch', () => {
      expect(() => fn([1], [1, 2])).toThrow('same dimensions');
    });

    it('throws on empty arrays', () => {
      expect(() => fn([], [])).toThrow('not be empty');
    });

    it('throws on sparse arrays', () => {
      // biome-ignore lint/suspicious/noSparseArray: Testing sparse array detection
      const sparse = [1, , 3] as number[];
      expect(() => fn(sparse, [1, 2, 3])).toThrow('Sparse arrays are not supported');
      expect(() => fn([1, 2, 3], sparse)).toThrow('Sparse arrays are not supported');
    });

    it('throws on sparse arrays (unrolled loop path)', () => {
      const sparse = [1, 2, 3, 4, undefined, 6, 7, 8] as number[];
      const normal = [1, 2, 3, 4, 5, 6, 7, 8];
      expect(() => fn(sparse, normal)).toThrow('Sparse arrays are not supported');
      expect(() => fn(normal, sparse)).toThrow('Sparse arrays are not supported');
    });

    it('throws on NaN values', () => {
      expect(() => fn([1, Number.NaN, 3], [1, 2, 3])).toThrow('Embeddings must not contain NaN');
      expect(() => fn([1, 2, 3], [1, Number.NaN, 3])).toThrow('Embeddings must not contain NaN');
    });

    it('throws on NaN values (unrolled loop path)', () => {
      const withNaN = [1, 2, 3, 4, Number.NaN, 6, 7, 8];
      const normal = [1, 2, 3, 4, 5, 6, 7, 8];
      expect(() => fn(withNaN, normal)).toThrow('Embeddings must not contain NaN');
      expect(() => fn(normal, withNaN)).toThrow('Embeddings must not contain NaN');
    });

    it('throws on non-finite values', () => {
      expect(() => fn([1, Number.POSITIVE_INFINITY, 3], [1, 2, 3])).toThrow(
        'Embeddings must contain only finite numbers'
      );
      expect(() => fn([1, 2, 3], [1, Number.NEGATIVE_INFINITY, 3])).toThrow(
        'Embeddings must contain only finite numbers'
      );
    });

    it('throws on non-finite values (unrolled loop path)', () => {
      const withInfinity = [1, 2, 3, 4, Number.POSITIVE_INFINITY, 6, 7, 8];
      const normal = [1, 2, 3, 4, 5, 6, 7, 8];
      expect(() => fn(withInfinity, normal)).toThrow('Embeddings must contain only finite numbers');
      expect(() => fn(normal, withInfinity)).toThrow('Embeddings must contain only finite numbers');
    });

    it('throws on finite inputs that overflow the accumulator', () => {
      const huge = [1e200, 1e200, 1e200, 1e200];
      // L2 needs opposing values so (huge - -huge)^2 overflows; dot/cosine overflow from direct products.
      const other = fn === calculateL2Distance ? [-1e200, -1e200, -1e200, -1e200] : huge;
      expect(() => fn(huge, other)).toThrow(
        'Embedding operation produced non-finite intermediate values'
      );
    });
  });

  describe.each([
    ['magnitude', magnitude],
    ['normalize', normalize],
  ])('%s single vector edge cases', (_name, fn) => {
    it('throws on empty arrays', () => {
      expect(() => fn([])).toThrow('not be empty');
    });

    it('throws on sparse arrays', () => {
      // biome-ignore lint/suspicious/noSparseArray: Testing sparse array detection
      const sparse = [1, , 3] as number[];
      expect(() => fn(sparse)).toThrow('Sparse arrays are not supported');
    });

    it('throws on sparse arrays (unrolled loop path)', () => {
      const sparse = [1, 2, 3, 4, undefined, 6, 7, 8] as number[];
      expect(() => fn(sparse)).toThrow('Sparse arrays are not supported');
    });

    it('throws on NaN values', () => {
      expect(() => fn([1, Number.NaN, 3])).toThrow('Embeddings must not contain NaN');
    });

    it('throws on NaN values (unrolled loop path)', () => {
      expect(() => fn([1, 2, 3, 4, Number.NaN, 6, 7, 8])).toThrow(
        'Embeddings must not contain NaN'
      );
    });

    it('throws on non-finite values', () => {
      expect(() => fn([1, Number.POSITIVE_INFINITY, 3])).toThrow(
        'Embeddings must contain only finite numbers'
      );
    });

    it('throws on non-finite values (unrolled loop path)', () => {
      expect(() => fn([1, 2, 3, 4, Number.NEGATIVE_INFINITY, 6, 7, 8])).toThrow(
        'Embeddings must contain only finite numbers'
      );
    });

    it('throws on finite inputs that overflow the accumulator', () => {
      expect(() => fn([1e200, 1e200, 1e200, 1e200])).toThrow(
        'Embedding operation produced non-finite intermediate values'
      );
    });
  });

  it('returns a copy for zero-norm normalization', () => {
    const zeroVector = [0, 0, 0, 0];
    const normalized = normalize(zeroVector);
    expect(normalized).toEqual([0, 0, 0, 0]);
    expect(normalized).not.toBe(zeroVector);
  });
});
