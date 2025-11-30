import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput } from '../../../interfaces/provider';
import { TransformersEmbeddingProvider } from '../transformers-provider';

// Skip these tests in CI - they require downloading large ML models which times out
// These tests were previously skipped in CI (see successful run #426)
const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';

describe.skipIf(isCI)('TransformersEmbeddingProvider', () => {
  let provider: TransformersEmbeddingProvider;

  beforeEach(() => {
    // Create a new provider instance for each test
    provider = new TransformersEmbeddingProvider('jinaai/jina-embeddings-v2-base-code');
  });

  afterEach(async () => {
    // Clean up resources
    try {
      await provider.dispose();
    } catch {
      // Ignore disposal errors in tests
    }
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
    it('can be initialized', async () => {
      await provider.initialize();
      expect(provider.getStatus()).toBe('ready');
    });

    it('tracks initialization progress', async () => {
      const progressEvents: Array<{ stage: string; progress?: number }> = [];

      await provider.initialize((progress) => {
        progressEvents.push(progress);
      });

      // Should have received at least one progress event
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(provider.getStatus()).toBe('ready');
    });

    it('throws error for invalid model key', async () => {
      const invalidProvider = new TransformersEmbeddingProvider('nonexistent-model');

      await expect(invalidProvider.initialize()).rejects.toThrow();
    });
  });

  describe('embedding generation', () => {
    it('auto-initializes if not ready', async () => {
      const input: EmbeddingInput = {
        text: 'hello world',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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

    it('generates embedding for text', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        text: 'test embedding generation',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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

    it('returns consistent embeddings for same input', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        text: 'consistent test',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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

    it('generates different embeddings for different inputs', async () => {
      await provider.initialize();

      const input1: EmbeddingInput = {
        text: 'first text',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
      };

      const input2: EmbeddingInput = {
        text: 'second text',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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

    it('handles empty text input', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        text: '',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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

    it('validates generated embeddings automatically', async () => {
      await provider.initialize();

      const input: EmbeddingInput = {
        text: 'validation test',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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
    it('returns true when initialized', async () => {
      await provider.initialize();

      const available = await provider.isAvailable();

      expect(available).toBe(true);
    });

    it('auto-initializes when checking availability', async () => {
      const available = await provider.isAvailable();

      expect(available).toBe(true);
      expect(provider.getStatus()).toBe('ready');
    });

    it('returns false for invalid model', async () => {
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

  describe('resource management', () => {
    it('can be disposed', async () => {
      await provider.initialize();
      expect(provider.getStatus()).toBe('ready');

      await provider.dispose();

      expect(provider.getStatus()).toBe('idle');
    });

    it('can be reinitialized after disposal', async () => {
      await provider.initialize();
      await provider.dispose();

      await provider.initialize();

      expect(provider.getStatus()).toBe('ready');
    });
  });

  describe('error handling with Result pattern', () => {
    it('returns Result error instead of throwing for invalid model', async () => {
      const invalidProvider = new TransformersEmbeddingProvider('invalid-model-key');

      const input: EmbeddingInput = {
        text: 'test',
        modelId: 'invalid-model-key',
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

    it('handles service errors gracefully', async () => {
      await provider.initialize();

      // Access internal service to mock an error
      const service = provider.getService();
      const originalEmbed = service.generateDocEmbedding.bind(service);

      // Mock the service to throw an error
      service.generateDocEmbedding = vi.fn().mockRejectedValue(new Error('Service error'));

      const input: EmbeddingInput = {
        text: 'test',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
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
      const cpuProvider = new TransformersEmbeddingProvider(
        'jinaai/jina-embeddings-v2-base-code',
        'cpu'
      );

      expect(webgpuProvider).toBeDefined();
      expect(wasmProvider).toBeDefined();
      expect(cpuProvider).toBeDefined();
    });
  });

  describe('current model tracking', () => {
    it('returns null before initialization', () => {
      expect(provider.getCurrentModelKey()).toBeNull();
    });

    it('returns model key after initialization', async () => {
      await provider.initialize();

      const modelKey = provider.getCurrentModelKey();

      expect(modelKey).toBe('jinaai/jina-embeddings-v2-base-code');
    });
  });
});
