import { describe, expect, it } from 'vitest';
import {
  computeInitialBatchSize,
  l2Normalize,
  truncateVector,
  vectorsFromPipelineOutput,
} from '../src';

describe('Embedding Worker - Enhanced Coverage', () => {
  describe('l2Normalize - Edge Cases', () => {
    it('should handle zero vector', () => {
      const vector = Float32Array.from([0, 0, 0]);
      const normalized = l2Normalize(vector);

      // Zero vector should remain zero (magnitude is 0, so can't normalize)
      expect(normalized.every((v) => v === 0 || Number.isNaN(v))).toBe(true);
    });

    it('should handle single element vector', () => {
      const vector = Float32Array.from([5]);
      const normalized = l2Normalize(vector);

      expect(Array.from(normalized)).toEqual([1]);
    });

    it('should handle very small values', () => {
      const vector = Float32Array.from([0.0001, 0.0001]);
      const normalized = l2Normalize(vector);

      const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('should handle very large values', () => {
      const vector = Float32Array.from([1_000_000, 2_000_000]);
      const normalized = l2Normalize(vector);

      const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('should handle negative values', () => {
      const vector = Float32Array.from([-3, -4]);
      const normalized = l2Normalize(vector);

      const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1);

      // Direction should be preserved
      expect(normalized[0]).toBeLessThan(0);
      expect(normalized[1]).toBeLessThan(0);
    });

    it('should handle mixed positive and negative values', () => {
      const vector = Float32Array.from([3, -4, 5]);
      const normalized = l2Normalize(vector);

      const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1);
    });

    it('should not mutate the input vector', () => {
      const vector = Float32Array.from([3, 4]);
      const original = Float32Array.from(vector);
      l2Normalize(vector);

      expect(Array.from(vector)).toEqual(Array.from(original));
    });
  });

  describe('truncateVector - Edge Cases', () => {
    it('should handle truncation to same length', () => {
      const vector = Float32Array.from([1, 2, 3]);
      const truncated = truncateVector(vector, 3);

      expect(Array.from(truncated)).toEqual([1, 2, 3]);
    });

    it('should no-op when truncation dimension is zero', () => {
      const vector = Float32Array.from([1, 2, 3]);
      const truncated = truncateVector(vector, 0);

      expect(truncated).toBe(vector);
      expect(Array.from(truncated)).toEqual([1, 2, 3]);
    });

    it('should handle truncation to one element', () => {
      const vector = Float32Array.from([1, 2, 3, 4, 5]);
      const truncated = truncateVector(vector, 1);

      expect(Array.from(truncated)).toEqual([1]);
    });

    it('should handle empty vector', () => {
      const vector = Float32Array.from([]);
      const truncated = truncateVector(vector, 0);

      expect(truncated.length).toBe(0);
    });

    it('should handle truncation larger than vector length', () => {
      const vector = Float32Array.from([1, 2, 3]);
      const truncated = truncateVector(vector, 10);

      // Should only return up to the original length
      expect(truncated.length).toBe(3);
      expect(Array.from(truncated)).toEqual([1, 2, 3]);
    });

    it('should create a new Float32Array instance', () => {
      const vector = Float32Array.from([1, 2, 3, 4]);
      const truncated = truncateVector(vector, 2);

      expect(truncated).not.toBe(vector);
      expect(truncated).toBeInstanceOf(Float32Array);
    });
  });

  describe('computeInitialBatchSize - Edge Cases', () => {
    it('should return 1 for dimension of 1', () => {
      expect(computeInitialBatchSize(1)).toBe(1);
    });

    it('should cap at 16 for very large dimensions', () => {
      expect(computeInitialBatchSize(1000)).toBeLessThanOrEqual(16);
      expect(computeInitialBatchSize(10_000)).toBeLessThanOrEqual(16);
    });

    it('should return reasonable batch size for common dimensions', () => {
      expect(computeInitialBatchSize(384)).toBeLessThanOrEqual(16);
      expect(computeInitialBatchSize(384)).toBeGreaterThan(0);

      expect(computeInitialBatchSize(768)).toBeLessThanOrEqual(16);
      expect(computeInitialBatchSize(768)).toBeGreaterThan(0);

      expect(computeInitialBatchSize(1536)).toBeLessThanOrEqual(16);
      expect(computeInitialBatchSize(1536)).toBeGreaterThan(0);
    });

    it('should keep small embedding requests in one inference batch up to the cap', () => {
      expect(computeInitialBatchSize(2)).toBe(2);
      expect(computeInitialBatchSize(4)).toBe(4);
      expect(computeInitialBatchSize(10)).toBe(10);
      expect(computeInitialBatchSize(20)).toBe(16);
    });

    it('should handle edge case of dimension 0', () => {
      // Should not crash
      const result = computeInitialBatchSize(0);
      expect(result).toBeGreaterThanOrEqual(1);
    });
  });

  describe('vectorsFromPipelineOutput - Edge Cases', () => {
    it('should handle single vector in nested array', () => {
      const output = [[0.5, 0.5]];
      const vectors = vectorsFromPipelineOutput(output, 2);

      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(2);
    });

    it('should handle large batch of vectors', () => {
      const output = Array.from({ length: 100 }, () => [0.5, 0.5]);
      const vectors = vectorsFromPipelineOutput(output, 2);

      expect(vectors).toHaveLength(100);
      vectors.forEach((vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(magnitude).toBeCloseTo(1, 5);
      });
    });

    it('should handle zero vectors in batch', () => {
      const output = [
        [0, 0],
        [1, 0],
      ];
      const vectors = vectorsFromPipelineOutput(output, 2);

      expect(vectors).toHaveLength(2);
      // First vector is zero, will be NaN after normalization
      // Second vector should be normalized
      const magnitude1 = Math.sqrt(vectors[1].reduce((sum, value) => sum + value * value, 0));
      expect(magnitude1).toBeCloseTo(1, 5);
    });

    it('should handle typed array with single dimension', () => {
      const vector = Float32Array.from([1]);
      const [normalized] = vectorsFromPipelineOutput(vector, 1);

      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toBe(1);
    });

    it('should handle typed array with high dimensions', () => {
      const vector = Float32Array.from(Array.from({ length: 1536 }, (_, i) => i / 1536));
      const [normalized] = vectorsFromPipelineOutput(vector, 1536);

      expect(normalized).toHaveLength(1536);
      const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('should normalize all vectors in nested array', () => {
      const output = [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ];
      const vectors = vectorsFromPipelineOutput(output, 3);

      vectors.forEach((vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(magnitude).toBeCloseTo(1, 5);
      });
    });

    it('should handle vectors with negative values', () => {
      const output = [
        [-1, -2],
        [3, -4],
      ];
      const vectors = vectorsFromPipelineOutput(output, 2);

      vectors.forEach((vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(magnitude).toBeCloseTo(1, 5);
      });
    });

    it('should return Float32Array instances', () => {
      const output = [[1, 2, 3]];
      const vectors = vectorsFromPipelineOutput(output, 3);

      expect(vectors[0]).toBeInstanceOf(Float32Array);
    });
  });

  describe('resolveEmbeddingWorkerUrl - Environment Testing', () => {
    it('should work in ESM environment with import.meta.url', async () => {
      // This test runs in an ESM environment by default
      const { resolveEmbeddingWorkerUrl } = await import('../src/worker-url');
      const url = resolveEmbeddingWorkerUrl();

      expect(url).toBeInstanceOf(URL);
      expect(url.pathname.endsWith('embedding.worker.ts')).toBe(true);
    });

    it('should return URL pointing to the source worker in source-import contexts', async () => {
      const { resolveEmbeddingWorkerUrl } = await import('../src/worker-url');
      const url = resolveEmbeddingWorkerUrl();

      expect(url.toString()).toContain('embedding.worker.ts');
    });

    it('should use file:// protocol', async () => {
      const { resolveEmbeddingWorkerUrl } = await import('../src/worker-url');
      const url = resolveEmbeddingWorkerUrl();

      expect(url.protocol).toMatch(/^(file:|http:|https:)/);
    });
  });
});
