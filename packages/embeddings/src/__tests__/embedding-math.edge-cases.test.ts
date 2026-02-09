
import { describe, expect, it } from 'vitest';
import {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from '../embedding-math';

describe('Embedding Math Edge Cases', () => {
  describe('calculateCosineSimilarity', () => {
    it('returns NaN if input contains NaN', () => {
      const a = [1, 2, NaN, 4];
      const b = [1, 2, 3, 4];
      expect(calculateCosineSimilarity(a, b).similarity).toBeNaN();
    });

    it('handles Infinity', () => {
      const a = [1, 2, Infinity, 4];
      const b = [1, 2, 3, 4];
      // Infinity in dot product -> Infinity. Infinity in norm -> Infinity.
      // Infinity / Infinity -> NaN.
      expect(calculateCosineSimilarity(a, b).similarity).toBeNaN();
    });

    it('throws error for sparse arrays (regression)', () => {
      const a = [1, 2, undefined, 4] as unknown as number[];
      const b = [1, 2, 3, 4];
      expect(() => calculateCosineSimilarity(a, b)).toThrow(/Sparse arrays are not supported/);
    });
  });

  describe('calculateL2Distance', () => {
    it('returns NaN distance if input contains NaN', () => {
      const a = [1, NaN, 3];
      const b = [1, 2, 3];
      const result = calculateL2Distance(a, b);
      expect(result.distance).toBeNaN();
    });

    it('handles Infinity', () => {
      const a = [Infinity, 2, 3];
      const b = [1, 2, 3];
      // diff is Infinity. squaredDistance is Infinity. distance is Infinity.
      // similarity = 1 / (1 + Infinity) = 0.
      const result = calculateL2Distance(a, b);
      expect(result.distance).toBe(Infinity);
      expect(result.similarity).toBe(0);
    });

    it('throws error for sparse arrays', () => {
        const a = [1, undefined, 3] as unknown as number[];
        const b = [1, 2, 3];
        expect(() => calculateL2Distance(a, b)).toThrow(/Sparse arrays are not supported/);
    });
  });

  describe('calculateDotProduct', () => {
    it('returns NaN if input contains NaN', () => {
      const a = [1, NaN, 3];
      const b = [1, 2, 3];
      const result = calculateDotProduct(a, b);
      expect(result.similarity).toBeNaN();
    });

    it('returns Infinity if input contains Infinity', () => {
      const a = [Infinity, 2, 3];
      const b = [1, 2, 3];
      const result = calculateDotProduct(a, b);
      expect(result.similarity).toBe(Infinity);
    });
  });

  describe('magnitude', () => {
    it('returns NaN if input contains NaN', () => {
      const a = [1, NaN, 3];
      expect(magnitude(a)).toBeNaN();
    });

    it('returns Infinity if input contains Infinity', () => {
      const a = [1, Infinity, 3];
      expect(magnitude(a)).toBe(Infinity);
    });
  });

  describe('normalize', () => {
    it('propagates NaN if input contains NaN', () => {
        const a = [1, NaN, 3];
        // norm -> NaN. result -> NaN
        const result = normalize(a);
        expect(result[0]).toBeNaN();
    });

    it('handles Infinity correctly', () => {
        const a = [Infinity, 2, 3];
        // norm -> Infinity.
        // Infinity / Infinity -> NaN.
        // 2 / Infinity -> 0.
        const result = normalize(a);
        expect(result[0]).toBeNaN(); // Infinity component
        expect(result[1]).toBe(0);
    });
  });
});
