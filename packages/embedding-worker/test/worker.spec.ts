import { describe, expect, it } from 'vitest';
import {
  computeInitialBatchSize,
  l2Normalize,
  truncateVector,
  vectorsFromPipelineOutput,
} from '../src';
import { resolveEmbeddingWorkerUrl } from '../src/worker-url';

describe('shared math helpers', () => {
  it('normalizes vectors to unit length', () => {
    const vector = Float32Array.from([3, 4]);
    const normalized = l2Normalize(vector);
    const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1);
  });

  it('normalizes in-place when destination equals source', () => {
    const vector = Float32Array.from([3, 4]);
    const result = l2Normalize(vector, vector);
    expect(result).toBe(vector); // Same reference
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...vector)).toBeCloseTo(1);
  });

  it('writes to separate destination buffer when provided', () => {
    const source = Float32Array.from([3, 4]);
    const dest = new Float32Array(2);
    const result = l2Normalize(source, dest);
    expect(result).toBe(dest);
    expect(source[0]).toBe(3);
    expect(source[1]).toBe(4);
    expect(dest[0]).toBeCloseTo(0.6);
    expect(dest[1]).toBeCloseTo(0.8);
  });

  it('handles zero-vector gracefully without NaN', () => {
    const zeroVector = Float32Array.from([0, 0, 0]);
    const result = l2Normalize(zeroVector);
    // Zero vector should remain zero (magnitude factor becomes 1 when sum is 0)
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    // Ensure no NaN values
    expect(Number.isNaN(result[0])).toBe(false);
    expect(Number.isNaN(result[1])).toBe(false);
    expect(Number.isNaN(result[2])).toBe(false);
  });

  it('truncates vectors without mutating the input', () => {
    const vector = Float32Array.from([1, 2, 3, 4]);
    const truncated = truncateVector(vector, 2);
    expect(Array.from(truncated)).toEqual([1, 2]);
    expect(vector.length).toBe(4);
  });

  it('computes a capped batch size', () => {
    expect(computeInitialBatchSize(1)).toBe(1);
    expect(computeInitialBatchSize(64)).toBeLessThanOrEqual(16);
  });
});

describe('vectorsFromPipelineOutput', () => {
  it('handles nested number arrays', () => {
    const output = [
      [0.2, 0.8],
      [0.6, 0.4],
    ];
    const vectors = vectorsFromPipelineOutput(output, 2);
    expect(vectors).toHaveLength(2);
    const firstValue = vectors[0]?.[0];
    if (firstValue === undefined) {
      throw new Error('Expected first normalized component');
    }
    expect(Math.abs(firstValue - 0.2425)).toBeLessThan(0.01);
  });

  it('returns a normalized vector for typed arrays', () => {
    const vector = Float32Array.from([0.2, 0.8, 0.6]);
    const [normalized] = vectorsFromPipelineOutput(vector, 3);
    if (!normalized) {
      throw new Error('Expected normalized vector');
    }
    const length = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeCloseTo(1);
  });

  it('handles arrays with undefined values by converting to 0', () => {
    // Sparse array with undefined at index 1
    const sparseArray = [0.3, undefined, 0.4];
    const [normalized] = vectorsFromPipelineOutput(sparseArray, 3);
    if (!normalized) {
      throw new Error('Expected normalized sparse vector');
    }
    // Undefined should be converted to 0, not NaN
    expect(normalized).toBeInstanceOf(Float32Array);
    expect(Number.isNaN(normalized[1])).toBe(false);
  });
});

describe('resolveEmbeddingWorkerUrl', () => {
  it('points to the source worker asset when imported from source', () => {
    const url = resolveEmbeddingWorkerUrl();
    expect(url.pathname.endsWith('embedding.worker.ts')).toBe(true);
  });
});
