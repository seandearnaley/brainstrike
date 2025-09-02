import { describe, expect, it } from 'vitest';
import { SimpleEmbeddingService } from '../bge-m3-service';

describe('SimpleEmbeddingService (basic)', () => {
  it('exposes default model key and registry', () => {
    const svc = new SimpleEmbeddingService();
    const key = svc.getDefaultModelKey();
    const reg = svc.getRegistry();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(reg).toBeTruthy();
    expect(typeof reg).toBe('object');
  });

  it('calculates similarity for simple vectors', () => {
    const svc = new SimpleEmbeddingService();
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    expect(svc.calculateSimilarity(a, b).similarity).toBeCloseTo(1, 5);
    expect(svc.calculateSimilarity(a, c).similarity).toBeCloseTo(0, 5);
  });
});
