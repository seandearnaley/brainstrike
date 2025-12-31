import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimpleEmbeddingService } from '../bge-m3-service';
import { ModelRegistryManager } from '../model-registry';
import type { ModelRegistry } from '../types';
import { TEST_MODEL_KEYS, TEST_MODEL_REGISTRY } from './fixtures/model-registry-fixture';

let originalRegistry: ModelRegistry;

beforeEach(() => {
  originalRegistry = ModelRegistryManager.getRegistry();
  ModelRegistryManager.updateRegistry(TEST_MODEL_REGISTRY);
});

afterEach(() => {
  ModelRegistryManager.updateRegistry(originalRegistry);
});

describe('SimpleEmbeddingService (basic)', () => {
  it('exposes default model key and registry', () => {
    const svc = new SimpleEmbeddingService();
    const key = svc.getDefaultModelKey();
    const reg = svc.getRegistry();
    expect(key).toBe(TEST_MODEL_KEYS.jinaCode);
    expect(reg.default).toBe(TEST_MODEL_KEYS.jinaCode);
  });

  it('calculates similarity for simple vectors', () => {
    const svc = new SimpleEmbeddingService();
    const a = Array.from(new Float32Array([1, 0, 0]));
    const b = Array.from(new Float32Array([1, 0, 0]));
    const c = Array.from(new Float32Array([0, 1, 0]));
    expect(svc.calculateSimilarity(a, b).similarity).toBeCloseTo(1, 5);
    expect(svc.calculateSimilarity(a, c).similarity).toBeCloseTo(0, 5);
  });
});
