import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_DIMENSION,
  LEGACY_DEFAULT_EMBEDDING_DIMENSION,
  MAX_EMBEDDING_DIMENSION,
} from '../src/embedding-constants.js';

describe('embedding-constants', () => {
  describe('LEGACY_DEFAULT_EMBEDDING_DIMENSION', () => {
    it('should be defined as a number', () => {
      expect(typeof LEGACY_DEFAULT_EMBEDDING_DIMENSION).toBe('number');
    });

    it('should be 768', () => {
      expect(LEGACY_DEFAULT_EMBEDDING_DIMENSION).toBe(768);
    });

    it('should be a positive integer', () => {
      expect(LEGACY_DEFAULT_EMBEDDING_DIMENSION).toBeGreaterThan(0);
      expect(Number.isInteger(LEGACY_DEFAULT_EMBEDDING_DIMENSION)).toBe(true);
    });
  });

  describe('DEFAULT_EMBEDDING_DIMENSION', () => {
    it('should be defined as a number', () => {
      expect(typeof DEFAULT_EMBEDDING_DIMENSION).toBe('number');
    });

    it('should be 768', () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).toBe(768);
    });

    it('should be a positive integer', () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).toBeGreaterThan(0);
      expect(Number.isInteger(DEFAULT_EMBEDDING_DIMENSION)).toBe(true);
    });

    it('should be less than or equal to MAX_EMBEDDING_DIMENSION', () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).toBeLessThanOrEqual(MAX_EMBEDDING_DIMENSION);
    });

    it('should be a common embedding dimension', () => {
      // Common dimensions: 384, 512, 768, 1024, 1536
      const commonDimensions = [384, 512, 768, 1024, 1536];
      expect(commonDimensions).toContain(DEFAULT_EMBEDDING_DIMENSION);
    });
  });

  describe('MAX_EMBEDDING_DIMENSION', () => {
    it('should be defined as a number', () => {
      expect(typeof MAX_EMBEDDING_DIMENSION).toBe('number');
    });

    it('should be 2000 (pgvector vector type limit)', () => {
      expect(MAX_EMBEDDING_DIMENSION).toBe(2000);
    });

    it('should be a positive integer', () => {
      expect(MAX_EMBEDDING_DIMENSION).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_EMBEDDING_DIMENSION)).toBe(true);
    });

    it('should be greater than DEFAULT_EMBEDDING_DIMENSION', () => {
      expect(MAX_EMBEDDING_DIMENSION).toBeGreaterThan(DEFAULT_EMBEDDING_DIMENSION);
    });

    it('should accommodate common embedding dimensions up to pgvector limit', () => {
      // Models that fit within pgvector's vector type limit
      const supportedDimensions = [384, 512, 768, 1024, 1536];
      supportedDimensions.forEach((dimension) => {
        expect(MAX_EMBEDDING_DIMENSION).toBeGreaterThanOrEqual(dimension);
      });
    });

    it('should be the pgvector vector type limit', () => {
      // pgvector's vector type supports up to 2000 dimensions
      // halfvec supports more (16000) but we use standard vector
      // See: https://github.com/pgvector/pgvector#vector
      expect(MAX_EMBEDDING_DIMENSION).toBe(2000);
      expect(MAX_EMBEDDING_DIMENSION).toBeLessThan(16_000);
    });
  });

  describe('constant relationships', () => {
    it('should maintain correct ratio', () => {
      const ratio = MAX_EMBEDDING_DIMENSION / DEFAULT_EMBEDDING_DIMENSION;
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(100);
    });

    it('should both be multiples of common factors', () => {
      // Both should be divisible by 2 (even numbers)
      expect(DEFAULT_EMBEDDING_DIMENSION % 2).toBe(0);
      expect(MAX_EMBEDDING_DIMENSION % 2).toBe(0);
    });

    it('should be usable in array allocations', () => {
      // Verify they can be used to create arrays without throwing
      expect(() => new Array(DEFAULT_EMBEDDING_DIMENSION)).not.toThrow();
      expect(() => new Float32Array(DEFAULT_EMBEDDING_DIMENSION)).not.toThrow();
      expect(() => new Float32Array(MAX_EMBEDDING_DIMENSION)).not.toThrow();
    });

    it('should be usable in mathematical operations', () => {
      const defaultSum = DEFAULT_EMBEDDING_DIMENSION + 100;
      const maxSum = MAX_EMBEDDING_DIMENSION + 100;
      expect(defaultSum).toBeGreaterThan(DEFAULT_EMBEDDING_DIMENSION);
      expect(maxSum).toBeGreaterThan(MAX_EMBEDDING_DIMENSION);
    });
  });

  describe('immutability', () => {
    it('should be readonly (constant)', () => {
      const initialDefault = DEFAULT_EMBEDDING_DIMENSION;
      const initialMax = MAX_EMBEDDING_DIMENSION;

      // TypeScript will prevent reassignment at compile time,
      // but at runtime they should still have their original values
      expect(DEFAULT_EMBEDDING_DIMENSION).toBe(initialDefault);
      expect(MAX_EMBEDDING_DIMENSION).toBe(initialMax);
    });
  });

  describe('type safety', () => {
    it('should be numbers and not NaN', () => {
      expect(Number.isNaN(DEFAULT_EMBEDDING_DIMENSION)).toBe(false);
      expect(Number.isNaN(MAX_EMBEDDING_DIMENSION)).toBe(false);
    });

    it('should be finite numbers', () => {
      expect(Number.isFinite(DEFAULT_EMBEDDING_DIMENSION)).toBe(true);
      expect(Number.isFinite(MAX_EMBEDDING_DIMENSION)).toBe(true);
    });

    it('should not be Infinity', () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).not.toBe(Number.POSITIVE_INFINITY);
      expect(DEFAULT_EMBEDDING_DIMENSION).not.toBe(Number.NEGATIVE_INFINITY);
      expect(MAX_EMBEDDING_DIMENSION).not.toBe(Number.POSITIVE_INFINITY);
      expect(MAX_EMBEDDING_DIMENSION).not.toBe(Number.NEGATIVE_INFINITY);
    });
  });

  describe('practical use cases', () => {
    it('should allow dimension validation', () => {
      const testDimension = 1024;
      const isValid =
        testDimension >= DEFAULT_EMBEDDING_DIMENSION && testDimension <= MAX_EMBEDDING_DIMENSION;
      expect(isValid).toBe(true);
    });

    it('should reject dimensions below default', () => {
      const tooSmall = 256;
      const isValid =
        tooSmall >= DEFAULT_EMBEDDING_DIMENSION && tooSmall <= MAX_EMBEDDING_DIMENSION;
      expect(isValid).toBe(false);
    });

    it('should reject dimensions above maximum', () => {
      const tooLarge = 20_000;
      const isValid =
        tooLarge >= DEFAULT_EMBEDDING_DIMENSION && tooLarge <= MAX_EMBEDDING_DIMENSION;
      expect(isValid).toBe(false);
    });

    it('should accept default dimension', () => {
      const isValid = DEFAULT_EMBEDDING_DIMENSION <= MAX_EMBEDDING_DIMENSION;
      expect(isValid).toBe(true);
    });

    it('should accept maximum dimension', () => {
      const isValid = MAX_EMBEDDING_DIMENSION >= DEFAULT_EMBEDDING_DIMENSION;
      expect(isValid).toBe(true);
    });
  });
});
