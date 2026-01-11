import { describe, expect, it } from 'vitest';
import { SimpleEmbeddingService } from '../bge-m3-service';

describe('SimpleEmbeddingService (basic)', () => {
  it('calculates similarity for simple vectors', () => {
    const svc = new SimpleEmbeddingService();
    const a = Array.from(new Float32Array([1, 0, 0]));
    const b = Array.from(new Float32Array([1, 0, 0]));
    const c = Array.from(new Float32Array([0, 1, 0]));
    expect(svc.calculateSimilarity(a, b).similarity).toBeCloseTo(1, 5);
    expect(svc.calculateSimilarity(a, c).similarity).toBeCloseTo(0, 5);
  });

  it('handles normalized vectors correctly', () => {
    const svc = new SimpleEmbeddingService();

    // Test with normalized vectors (common in embeddings)
    const vector1 = [0.6, 0.8, 0.0]; // magnitude = 1
    const vector2 = [0.8, 0.6, 0.0]; // magnitude = 1

    const result = svc.calculateSimilarity(vector1, vector2);

    // For normalized vectors, dot product = cosine similarity
    const expectedSimilarity = 0.6 * 0.8 + 0.8 * 0.6 + 0.0 * 0.0;
    expect(result.similarity).toBeCloseTo(expectedSimilarity, 5);
  });

  it('rejects vectors of different dimensions', () => {
    const svc = new SimpleEmbeddingService();

    const vector1 = [1, 2, 3];
    const vector2 = [1, 2]; // Different length

    expect(() => {
      svc.calculateSimilarity(vector1, vector2);
    }).toThrow('Embeddings must have the same dimensions');
  });

  it('handles edge cases safely', () => {
    const svc = new SimpleEmbeddingService();

    // Zero vectors
    const zero1 = [0, 0, 0];
    const zero2 = [0, 0, 0];
    const result1 = svc.calculateSimilarity(zero1, zero2);
    expect(result1.similarity).toBe(0); // Should return 0 for zero vectors, not NaN
    expect(result1.distance).toBe(1);

    // Very small values
    const small1 = [1e-10, 1e-10, 1e-10];
    const small2 = [1e-10, 1e-10, 1e-10];
    const result2 = svc.calculateSimilarity(small1, small2);
    expect(result2.similarity).toBeCloseTo(1.0, 5);
  });
});
