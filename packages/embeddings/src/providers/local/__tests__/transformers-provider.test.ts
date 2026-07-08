import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../interfaces/provider';
import { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } from '../../../runtime-config';
import { TransformersEmbeddingProvider } from '../transformers-provider';

// Skip these tests in CI - they require downloading large ML models which times out
// These tests were previously skipped in CI (see successful run #426)
const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
const slowTestTimeoutMs = 30_000;
const slowTest = (name: string, fn: () => Promise<void> | void) => it(name, fn, slowTestTimeoutMs);

type QueueAddCall = Parameters<QueueAdapter['add']>[0];

function hashText(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000;
  }
  return hash;
}

function buildVector(seed: number, length: number): number[] {
  const base = seed % 1000;
  return Array.from({ length }, (_, index) => (base + index) / 1000);
}

function createQueueResult(id: string, vectors: Float32Array[]): QueueResult {
  const dimensions = vectors[0]?.length ?? DEFAULT_EMBEDDING_DIMENSION;
  return {
    id,
    metadata: {
      batchSize: vectors.length,
      device: 'wasm',
      dimensions,
      dtype: 'fp32',
      elapsedMs: 1,
      fallbackApplied: false,
      model: 'jinaai/jina-embeddings-v2-base-code',
    },
    type: 'result',
    vectors,
  };
}

function createQueueStub() {
  const add = vi.fn<QueueAdapter['add']>();
  add.mockImplementation(async (task: QueueAddCall) => {
    const dimension =
      typeof task.targetDimension === 'number' && task.targetDimension > 0
        ? task.targetDimension
        : DEFAULT_EMBEDDING_DIMENSION;
    const vectors = task.texts.map((text) =>
      Float32Array.from(buildVector(hashText(text), dimension))
    );
    return createQueueResult(task.id, vectors);
  });

  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    get isPaused() {
      return false;
    },
    get isProcessing() {
      return false;
    },
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };

  return { add, queue };
}

describe.skipIf(isCI)('TransformersEmbeddingProvider', () => {
  let provider: TransformersEmbeddingProvider;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class {});
    const { queue } = createQueueStub();
    registerEmbeddingQueueFactory(() => queue);
    // Create a new provider instance for each test
    provider = new TransformersEmbeddingProvider('jinaai/jina-embeddings-v2-base-code', 'wasm');
  });

  afterEach(async () => {
    // Clean up resources
    try {
      await provider.dispose();
    } catch {
      // Ignore disposal errors in tests
    }
    resetEmbeddingQueueFactory();
    vi.unstubAllGlobals();
  });

  describe('provider metadata', () => {
    it('has correct runtime and provider type', () => {
      expect(provider.runtime).toBe('browser');
      expect(provider.provider).toBe('local');
    });

    it('returns idle status initially', () => {
      expect(provider.getStatus()).toBe('idle');
    });
  });

  describe('initialization', () => {
    slowTest('can be initialized', async () => {
      await provider.initialize();
      expect(provider.getStatus()).toBe('ready');
    });

    slowTest('tracks initialization progress', async () => {
      const progressEvents: Array<{ stage: string; progress?: number }> = [];

      await provider.initialize((progress) => {
        progressEvents.push(progress);
      });

      // Should have received at least one progress event
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(provider.getStatus()).toBe('ready');
    });

    slowTest('throws error for invalid model key', async () => {
      const invalidProvider = new TransformersEmbeddingProvider('nonexistent-model');

      await expect(invalidProvider.initialize()).rejects.toThrow();
    });
  });

  describe('embedding generation', () => {
    slowTest('auto-initializes if not ready', async () => {
      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'hello world',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toBeDefined();
        expect(Array.isArray(result.value.embedding)).toBe(true);
        expect(result.value.embedding.length).toBeGreaterThan(0);
        expect(result.value.modelId).toBe('jinaai/jina-embeddings-v2-base-code');
        expect(result.value.provider).toBe('local');
        expect(result.value.dimensions).toBe(result.value.embedding.length);
      }
    });

    slowTest('generates embedding for text', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'test embedding generation',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toBeDefined();
        expect(result.value.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSION);
        expect(result.value.modelId).toBe('jinaai/jina-embeddings-v2-base-code');
        expect(result.value.provider).toBe('local');
      }
    });

    slowTest('returns consistent embeddings for same input', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'consistent test',
      };

      const result1 = await provider.embed(input);
      const result2 = await provider.embed(input);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Embeddings should be identical for the same input
        expect(result1.value.embedding).toEqual(result2.value.embedding);
      }
    });

    slowTest('generates different embeddings for different inputs', async () => {
      await provider.initialize();

      const input1: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'first text',
      };

      const input2: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'second text',
      };

      const result1 = await provider.embed(input1);
      const result2 = await provider.embed(input2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Embeddings should be different for different inputs
        expect(result1.value.embedding).not.toEqual(result2.value.embedding);
      }
    });

    slowTest('handles empty text input', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: '',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toBeDefined();
        expect(result.value.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSION);
      }
    });
  });

  describe('dimension validation', () => {
    it('validates correct dimensions', () => {
      const embedding = new Array(DEFAULT_EMBEDDING_DIMENSION).fill(0);

      const result = provider.validateDimensions(embedding, DEFAULT_EMBEDDING_DIMENSION);

      expect(result.ok).toBe(true);
    });

    it('rejects incorrect dimensions', () => {
      const wrongDimension = 512; // Wrong dimension
      const embedding = new Array(wrongDimension).fill(0);

      const result = provider.validateDimensions(embedding, DEFAULT_EMBEDDING_DIMENSION);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('dimension_mismatch');
        if (result.error.type === 'dimension_mismatch') {
          expect(result.error.expected).toBe(DEFAULT_EMBEDDING_DIMENSION);
          expect(result.error.received).toBe(wrongDimension);
          expect(result.error.modelId).toBe('jinaai/jina-embeddings-v2-base-code');
        }
      }
    });

    slowTest('validates generated embeddings automatically', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'validation test',
      };

      const result = await provider.embed(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Generated embeddings should already be validated
        expect(result.value.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
      }
    });
  });

  describe('provider availability', () => {
    slowTest('returns true when initialized', async () => {
      await provider.initialize();

      const available = await provider.isAvailable();

      expect(available).toBe(true);
    });

    slowTest('auto-initializes when checking availability', async () => {
      const available = await provider.isAvailable();

      expect(available).toBe(true);
      expect(provider.getStatus()).toBe('ready');
    });

    slowTest('returns false for invalid model', async () => {
      const invalidProvider = new TransformersEmbeddingProvider('invalid-model');

      const available = await invalidProvider.isAvailable();

      expect(available).toBe(false);
    });
  });

  describe('model information', () => {
    it('returns model info for valid model', () => {
      const modelInfo = provider.getModelInfo('jinaai/jina-embeddings-v2-base-code');

      expect(modelInfo).toBeDefined();
      if (modelInfo) {
        expect(modelInfo.id).toBeDefined();
        expect(modelInfo.name).toBeDefined();
        expect(modelInfo.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
      }
    });

    it('returns null for invalid model', () => {
      const modelInfo = provider.getModelInfo('nonexistent-model');

      expect(modelInfo).toBeNull();
    });
  });

  describe('getMetadata (BST-167)', () => {
    it('returns unified provider metadata for valid model', () => {
      const metadata = provider.getMetadata('jinaai/jina-embeddings-v2-base-code');

      expect(metadata).toBeDefined();
      expect(metadata?.providerId).toBe('local');
      expect(metadata?.modelKey).toBe('jinaai/jina-embeddings-v2-base-code');
      expect(metadata?.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
      expect(metadata?.distance).toBe('cosine');
      expect(metadata?.displayName).toBeDefined();
    });

    it('returns null for unknown model', () => {
      const metadata = provider.getMetadata('nonexistent-model');

      expect(metadata).toBeNull();
    });
  });

  describe('resource management', () => {
    slowTest('can be disposed', async () => {
      await provider.initialize();
      expect(provider.getStatus()).toBe('ready');

      await provider.dispose();

      expect(provider.getStatus()).toBe('idle');
    });

    slowTest('can be reinitialized after disposal', async () => {
      await provider.initialize();
      await provider.dispose();

      await provider.initialize();

      expect(provider.getStatus()).toBe('ready');
    });
  });

  describe('error handling with Result pattern', () => {
    slowTest('returns Result error instead of throwing for invalid model', async () => {
      const invalidProvider = new TransformersEmbeddingProvider('invalid-model-key');

      const input: EmbeddingInput = {
        modelId: 'invalid-model-key',
        text: 'test',
      };

      const result = await invalidProvider.embed(input);

      // Should return error Result, not throw
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('model_load_failed');
        if (result.error.type === 'model_load_failed') {
          expect(result.error.provider).toBe('local');
          expect(result.error.modelId).toBe('invalid-model-key');
        }
      }
    });

    slowTest('handles service errors gracefully', async () => {
      await provider.initialize();

      // Access internal service to mock an error
      const service = provider.getService();
      const originalEmbed = service.generateDocEmbedding.bind(service);

      // Mock the service to throw an error
      service.generateDocEmbedding = vi.fn().mockRejectedValue(new Error('Service error'));

      const input: EmbeddingInput = {
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        text: 'test',
      };

      const result = await provider.embed(input);

      // Should return error Result, not throw
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('model_load_failed');
        if (result.error.type === 'model_load_failed') {
          expect(result.error.reason).toContain('Service error');
        }
      }

      // Restore original method
      service.generateDocEmbedding = originalEmbed;
    });
  });

  describe('device override', () => {
    it('accepts device override in constructor', () => {
      const webgpuProvider = new TransformersEmbeddingProvider(
        'jinaai/jina-embeddings-v2-base-code',
        'webgpu'
      );
      const wasmProvider = new TransformersEmbeddingProvider(
        'jinaai/jina-embeddings-v2-base-code',
        'wasm'
      );

      expect(webgpuProvider).toBeDefined();
      expect(wasmProvider).toBeDefined();
    });
  });

  describe('current model tracking', () => {
    it('returns null before initialization', () => {
      expect(provider.getCurrentModelKey()).toBeNull();
    });

    slowTest('returns model key after initialization', async () => {
      await provider.initialize();

      const modelKey = provider.getCurrentModelKey();

      expect(modelKey).toBe('jinaai/jina-embeddings-v2-base-code');
    });
  });
});
