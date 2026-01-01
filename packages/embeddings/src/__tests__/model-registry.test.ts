/**
 * Unit tests for model registry functionality
 * These tests don't require downloading models
 */

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

describe('Model Registry Tests', () => {
  describe('ModelRegistryManager', () => {
    it('should load models from registry', () => {
      const models = ModelRegistryManager.listModels();

      expect(models).toBeDefined();
      expect(Object.keys(models).length).toBeGreaterThan(0);
    });

    it('should include hosted providers in listModels()', () => {
      const models = ModelRegistryManager.listModels();

      // Check that hosted providers are included with proper keys
      expect(models[TEST_MODEL_KEYS.openaiSmall]).toBeDefined();
      expect(models[TEST_MODEL_KEYS.openaiLarge]).toBeDefined();
      expect(models[TEST_MODEL_KEYS.voyage3]).toBeDefined();
      expect(models[TEST_MODEL_KEYS.cohereEnglish]).toBeDefined();

      // Verify hosted models have correct dimensions
      expect(models[TEST_MODEL_KEYS.openaiSmall]?.dimensions).toBe(1536);
      expect(models[TEST_MODEL_KEYS.openaiLarge]?.dimensions).toBe(3072);
      expect(models[TEST_MODEL_KEYS.voyage3]?.dimensions).toBe(1024);
    });

    it('should have jina-code as default model', () => {
      const defaultKey = ModelRegistryManager.getDefaultModelKey();
      expect(defaultKey).toBe(TEST_MODEL_KEYS.jinaCode);

      const defaultModel = ModelRegistryManager.getDefaultModel();
      expect(defaultModel.id).toBe(TEST_MODEL_KEYS.jinaCode);
      expect(defaultModel.name).toBe('Jina Code v2 (default)');
      expect(defaultModel.dimensions).toBe(768);
      expect(defaultModel.tags).toContain('code');
    });

    it('should get specific model configurations', () => {
      const jinaModel = ModelRegistryManager.getModel(TEST_MODEL_KEYS.jinaCode);
      expect(jinaModel).toBeDefined();
      expect(jinaModel?.id).toBe(TEST_MODEL_KEYS.jinaCode);

      const miniLM = ModelRegistryManager.getModel(TEST_MODEL_KEYS.miniLm);
      expect(miniLM).toBeDefined();
      expect(miniLM?.dimensions).toBe(384);

      const nonExistent = ModelRegistryManager.getModel('non-existent');
      expect(nonExistent).toBeNull();
    });

    it('should get model configurations by HuggingFace ID', () => {
      // Lookup by full HuggingFace model ID (the `id` field in registry)
      const miniLM = ModelRegistryManager.getModel(TEST_MODEL_KEYS.miniLm);
      expect(miniLM).toBeDefined();
      expect(miniLM?.id).toBe(TEST_MODEL_KEYS.miniLm);
      expect(miniLM?.dimensions).toBe(384);

      const jinaCode = ModelRegistryManager.getModel(TEST_MODEL_KEYS.jinaCode);
      expect(jinaCode).toBeDefined();
      expect(jinaCode?.id).toBe(TEST_MODEL_KEYS.jinaCode);
      expect(jinaCode?.dimensions).toBe(768);

      // Verify hasModel also works with HuggingFace IDs
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.miniLm)).toBe(true);
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.jinaCode)).toBe(true);
      expect(ModelRegistryManager.hasModel('Xenova/nonexistent-model')).toBe(false);
    });

    it('should get model configurations by local provider composite keys', () => {
      // Lookup by transformers::HuggingFaceID format (as stored in database)
      const miniLM = ModelRegistryManager.getModel(`transformers::${TEST_MODEL_KEYS.miniLm}`);
      expect(miniLM).toBeDefined();
      expect(miniLM?.id).toBe(TEST_MODEL_KEYS.miniLm);
      expect(miniLM?.dimensions).toBe(384);

      // Lookup by local::HuggingFaceId format
      const jinaCode = ModelRegistryManager.getModel(`local::${TEST_MODEL_KEYS.jinaCode}`);
      expect(jinaCode).toBeDefined();
      expect(jinaCode?.id).toBe(TEST_MODEL_KEYS.jinaCode);

      // Lookup by transformers::HuggingFaceId format
      const bgeSmall = ModelRegistryManager.getModel(`transformers::${TEST_MODEL_KEYS.bgeSmall}`);
      expect(bgeSmall).toBeDefined();
      expect(bgeSmall?.id).toBe(TEST_MODEL_KEYS.bgeSmall);

      // Verify hasModel also works with local provider composite keys
      expect(ModelRegistryManager.hasModel(`transformers::${TEST_MODEL_KEYS.miniLm}`)).toBe(true);
      expect(ModelRegistryManager.hasModel(`local::${TEST_MODEL_KEYS.jinaCode}`)).toBe(true);
      expect(ModelRegistryManager.hasModel('transformers::nonexistent-model')).toBe(false);
    });

    it('should get hosted provider model configurations', () => {
      // Test OpenAI models
      const openaiSmall = ModelRegistryManager.getModel(TEST_MODEL_KEYS.openaiSmall);
      expect(openaiSmall).toBeDefined();
      expect(openaiSmall?.dimensions).toBe(1536);

      const openaiLarge = ModelRegistryManager.getModel(TEST_MODEL_KEYS.openaiLarge);
      expect(openaiLarge).toBeDefined();
      expect(openaiLarge?.dimensions).toBe(3072);

      // Test Voyage models
      const voyage = ModelRegistryManager.getModel(TEST_MODEL_KEYS.voyage3);
      expect(voyage).toBeDefined();
      expect(voyage?.dimensions).toBe(1024);

      // Test Cohere models
      const cohere = ModelRegistryManager.getModel(TEST_MODEL_KEYS.cohereEnglish);
      expect(cohere).toBeDefined();
      expect(cohere?.dimensions).toBe(1024);

      // Test non-existent hosted model
      const nonExistent = ModelRegistryManager.getModel('openai::non-existent-model');
      expect(nonExistent).toBeNull();
    });

    it('should check model existence', () => {
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.jinaCode)).toBe(true);
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.miniLm)).toBe(true);
      expect(ModelRegistryManager.hasModel('non-existent')).toBe(false);
    });

    it('should check hosted provider model existence', () => {
      // Test hosted models exist
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.openaiSmall)).toBe(true);
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.openaiLarge)).toBe(true);
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.voyage3)).toBe(true);
      expect(ModelRegistryManager.hasModel(TEST_MODEL_KEYS.cohereEnglish)).toBe(true);

      // Test non-existent hosted models
      expect(ModelRegistryManager.hasModel('openai::non-existent')).toBe(false);
      expect(ModelRegistryManager.hasModel('unknown-provider::model')).toBe(false);
    });

    it('should filter models by tag', () => {
      const codeModels = ModelRegistryManager.getModelsByTag('code');
      expect(Object.keys(codeModels).length).toBeGreaterThan(0);
      expect(codeModels[TEST_MODEL_KEYS.jinaCode]).toBeDefined();

      const englishModels = ModelRegistryManager.getModelsByTag('english');
      expect(Object.keys(englishModels).length).toBeGreaterThan(0);

      const nonExistentTag = ModelRegistryManager.getModelsByTag('non-existent-tag');
      expect(Object.keys(nonExistentTag).length).toBe(0);
    });

    it('should respect explicit quantization flags from registry', () => {
      const models = ModelRegistryManager.listModels();

      // Test jina-code (768D, should force quantization)
      const jinaCode = models[TEST_MODEL_KEYS.jinaCode];
      expect(jinaCode).toBeDefined();
      expect(ModelRegistryManager.shouldQuantize(jinaCode!)).toBe(false);

      // Test all-MiniLM-L6-v2 (384D, should force quantization)
      const miniLM = models[TEST_MODEL_KEYS.miniLm];
      expect(miniLM).toBeDefined();
      expect(ModelRegistryManager.shouldQuantize(miniLM!)).toBe(false);

      // Test BGE-Large (1024D, should recommend quantization)
      const bgeLarge = models[TEST_MODEL_KEYS.bgeLarge];
      if (bgeLarge) {
        expect(ModelRegistryManager.shouldQuantize(bgeLarge)).toBe(false);
      }
    });

    it('should auto-quantize models without explicit guidance when dimensions are small', () => {
      const previousRegistry = ModelRegistryManager.getRegistry();
      const testRegistry: ModelRegistry = {
        default: 'auto-model',
        models: {
          'auto-model': {
            id: 'auto/model',
            name: 'Auto Model',
            dimensions: 512,
            description: 'Auto quantization test',
            tags: ['test'],
            origin: 'Test',
            size: '50MB',
          },
        },
      };

      ModelRegistryManager.updateRegistry(testRegistry);
      const autoModel = ModelRegistryManager.getModel('auto-model');
      expect(autoModel).toBeDefined();
      expect(ModelRegistryManager.shouldQuantize(autoModel!)).toBe(true);

      ModelRegistryManager.updateRegistry(previousRegistry);
    });

    it('should allow registry updates', () => {
      const previousRegistry = ModelRegistryManager.getRegistry();

      const testRegistry: ModelRegistry = {
        default: 'test-model',
        models: {
          'test-model': {
            id: 'test/model',
            name: 'Test Model',
            dimensions: 512,
            quantized: true,
            description: 'Test model for testing',
            tags: ['test'],
            origin: 'Test',
            size: '100MB',
          },
        },
      };

      ModelRegistryManager.updateRegistry(testRegistry);

      expect(ModelRegistryManager.getDefaultModelKey()).toBe('test-model');
      expect(ModelRegistryManager.hasModel('test-model')).toBe(true);

      // Restore original registry
      ModelRegistryManager.updateRegistry(previousRegistry);
      expect(ModelRegistryManager.getDefaultModelKey()).toBe(TEST_MODEL_KEYS.jinaCode);
    });
  });

  describe('Model Configuration Validation', () => {
    it('should have required properties for all models', () => {
      const models = ModelRegistryManager.listModels();

      for (const [key, model] of Object.entries(models)) {
        // All models should have these common properties
        expect(model.name).toBeDefined();
        expect(model.dimensions).toBeGreaterThan(0);
        expect(model.description).toBeDefined();
        expect(Array.isArray(model.tags)).toBe(true);

        // Check if it's a hosted model (has :: in key)
        if (key.includes('::')) {
          // Hosted models have different required fields
          expect(model.contextWindow).toBeGreaterThan(0);
          expect(model.pricePer1MTokens).toBeGreaterThan(0);
        } else {
          // Local models have these additional fields
          expect(model.id).toBeDefined();
          expect(typeof model.quantized).toBe('boolean');
          expect(model.origin).toBeDefined();
          expect(model.size).toBeDefined();
        }
      }
    });

    it('should have consistent model IDs with proper prefixes for local models', () => {
      const models = ModelRegistryManager.listModels();

      for (const [key, model] of Object.entries(models)) {
        // Only check local models (not hosted providers)
        if (!key.includes('::')) {
          // Most models use Xenova/ prefix, but Jina uses jinaai/ prefix
          expect(model.id).toMatch(/^(Xenova|jinaai)\//);
        }
      }
    });

    it('should have reasonable dimension values', () => {
      const models = ModelRegistryManager.listModels();

      for (const [_key, model] of Object.entries(models)) {
        expect(model.dimensions).toBeGreaterThan(100);
        expect(model.dimensions).toBeLessThan(5000);
        expect(model.dimensions % 1).toBe(0); // Should be integer
      }
    });

    it('should have non-empty tags for all models', () => {
      const models = ModelRegistryManager.listModels();

      for (const [_key, model] of Object.entries(models)) {
        expect(model.tags.length).toBeGreaterThan(0);
        expect(model.tags.every((tag) => typeof tag === 'string' && tag.length > 0)).toBe(true);
      }
    });
  });

  describe('Similarity Calculation Logic', () => {
    it('should calculate cosine similarity correctly', () => {
      const service = new SimpleEmbeddingService();

      // Test identical vectors
      const vector1 = [1, 0, 0];
      const vector2 = [1, 0, 0];
      const result1 = service.calculateSimilarity(vector1, vector2);
      expect(result1.similarity).toBeCloseTo(1.0, 5);
      expect(result1.distance).toBeCloseTo(0.0, 5);
      expect(result1.method).toBe('cosine');

      // Test orthogonal vectors
      const vector3 = [1, 0, 0];
      const vector4 = [0, 1, 0];
      const result2 = service.calculateSimilarity(vector3, vector4);
      expect(result2.similarity).toBeCloseTo(0.0, 5);
      expect(result2.distance).toBeCloseTo(1.0, 5);

      // Test opposite vectors
      const vector5 = [1, 0, 0];
      const vector6 = [-1, 0, 0];
      const result3 = service.calculateSimilarity(vector5, vector6);
      expect(result3.similarity).toBeCloseTo(-1.0, 5);
      expect(result3.distance).toBeCloseTo(2.0, 5);
    });

    it('should handle normalized vectors correctly', () => {
      const service = new SimpleEmbeddingService();

      // Test with normalized vectors (common in embeddings)
      const vector1 = [0.6, 0.8, 0.0]; // magnitude = 1
      const vector2 = [0.8, 0.6, 0.0]; // magnitude = 1

      const result = service.calculateSimilarity(vector1, vector2);

      // For normalized vectors, dot product = cosine similarity
      const expectedSimilarity = 0.6 * 0.8 + 0.8 * 0.6 + 0.0 * 0.0;
      expect(result.similarity).toBeCloseTo(expectedSimilarity, 5);
    });

    it('should reject vectors of different dimensions', () => {
      const service = new SimpleEmbeddingService();

      const vector1 = [1, 2, 3];
      const vector2 = [1, 2]; // Different length

      expect(() => {
        service.calculateSimilarity(vector1, vector2);
      }).toThrow('Embeddings must have the same dimensions');
    });

    it('should handle edge cases safely', () => {
      const service = new SimpleEmbeddingService();

      // Zero vectors
      const zero1 = [0, 0, 0];
      const zero2 = [0, 0, 0];
      const result1 = service.calculateSimilarity(zero1, zero2);
      expect(result1.similarity).toBe(0); // Should return 0 for zero vectors, not NaN
      expect(result1.distance).toBe(1);

      // Very small values
      const small1 = [1e-10, 1e-10, 1e-10];
      const small2 = [1e-10, 1e-10, 1e-10];
      const result2 = service.calculateSimilarity(small1, small2);
      expect(result2.similarity).toBeCloseTo(1.0, 5);
    });
  });
});
