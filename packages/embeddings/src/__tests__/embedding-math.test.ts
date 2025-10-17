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
});
