import { describe, expect, it } from 'vitest';
import {
  l2Normalize,
  truncateVector,
  computeInitialBatchSize,
  vectorsFromPipelineOutput,
  resolveEmbeddingWorkerUrl
} from '../src';

describe('shared math helpers', () => {
  it('normalizes vectors to unit length', () => {
    const vector = Float32Array.from([3, 4]);
    const normalized = l2Normalize(vector);
    const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1);
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
      [0.6, 0.4]
    ];
    const vectors = vectorsFromPipelineOutput(output, 2);
    expect(vectors).toHaveLength(2);
    expect(Math.abs(vectors[0][0] - 0.2425)).toBeLessThan(0.01);
  });

  it('returns a normalized vector for typed arrays', () => {
    const vector = Float32Array.from([0.2, 0.8, 0.6]);
    const [normalized] = vectorsFromPipelineOutput(vector, 3);
    const length = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeCloseTo(1);
  });
});

describe('resolveEmbeddingWorkerUrl', () => {
  it('points to the compiled worker asset', () => {
    const url = resolveEmbeddingWorkerUrl();
    expect(url.pathname.endsWith('embedding.worker.js')).toBe(true);
  });
});
