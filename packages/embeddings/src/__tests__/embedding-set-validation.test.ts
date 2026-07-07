/**
 * Tests for embedding set validation utilities (BST-168)
 */

import { describe, expect, it } from 'vitest';
import {
  createEmbeddingSetParamsFromMetadata,
  type EmbeddingSetCreateParams,
  isProviderCompatibleWithSet,
  validateEmbeddingDimensions,
  validateEmbeddingSetParams,
} from '../embedding-set-validation';
import type { ProviderMetadata } from '../provider-types';

describe('embedding-set-validation', () => {
  const openAIMetadata: ProviderMetadata = {
    dimensions: 1536,
    displayName: 'OpenAI text-embedding-3-small',
    distance: 'cosine',
    modelKey: 'text-embedding-3-small',
    providerId: 'openai',
  };

  const voyageMetadata: ProviderMetadata = {
    dimensions: 1024,
    displayName: 'Voyage 3',
    distance: 'cosine',
    modelKey: 'voyage-3',
    providerId: 'voyage',
  };

  const localMetadata: ProviderMetadata = {
    dimensions: 768,
    displayName: 'Jina Code v2',
    distance: 'cosine',
    modelKey: 'jinaai/jina-embeddings-v2-base-code',
    providerId: 'local',
  };

  describe('validateEmbeddingSetParams', () => {
    it('validates matching dimensions and distance', () => {
      const params: EmbeddingSetCreateParams = {
        dimensions: 1536,
        distance: 'cosine',
        modelId: 'text-embedding-3-small',
        modelKey: 'openai',
      };

      const result = validateEmbeddingSetParams(params, openAIMetadata);
      expect(result.ok).toBe(true);
    });

    it('rejects dimension mismatch', () => {
      const params: EmbeddingSetCreateParams = {
        dimensions: 512, // Wrong dimensions
        distance: 'cosine',
        modelId: 'text-embedding-3-small',
        modelKey: 'openai',
      };

      const result = validateEmbeddingSetParams(params, openAIMetadata);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('dimension_mismatch');
        if (result.error.type === 'dimension_mismatch') {
          expect(result.error.expected).toBe(1536);
          expect(result.error.provided).toBe(512);
          expect(result.error.modelKey).toBe('text-embedding-3-small');
        }
      }
    });

    it('rejects distance metric mismatch', () => {
      const params: EmbeddingSetCreateParams = {
        dimensions: 1536,
        distance: 'l2', // Wrong distance
        modelId: 'text-embedding-3-small',
        modelKey: 'openai',
      };

      const result = validateEmbeddingSetParams(params, openAIMetadata);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('distance_mismatch');
        if (result.error.type === 'distance_mismatch') {
          expect(result.error.expected).toBe('cosine');
          expect(result.error.provided).toBe('l2');
        }
      }
    });

    it('validates Voyage provider parameters', () => {
      const params: EmbeddingSetCreateParams = {
        dimensions: 1024,
        distance: 'cosine',
        modelId: 'voyage-3',
        modelKey: 'voyage',
      };

      const result = validateEmbeddingSetParams(params, voyageMetadata);
      expect(result.ok).toBe(true);
    });

    it('validates local Transformers provider parameters', () => {
      const params: EmbeddingSetCreateParams = {
        dimensions: 768,
        distance: 'cosine',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        modelKey: 'local',
      };

      const result = validateEmbeddingSetParams(params, localMetadata);
      expect(result.ok).toBe(true);
    });
  });

  describe('createEmbeddingSetParamsFromMetadata', () => {
    it('creates params from OpenAI metadata', () => {
      const params = createEmbeddingSetParamsFromMetadata(openAIMetadata);

      expect(params.modelKey).toBe('openai');
      expect(params.modelId).toBe('text-embedding-3-small');
      expect(params.dimensions).toBe(1536);
      expect(params.distance).toBe('cosine');
      expect(params.metadata?.name).toBe('OpenAI text-embedding-3-small (1536D)');
    });

    it('creates params from Voyage metadata', () => {
      const params = createEmbeddingSetParamsFromMetadata(voyageMetadata);

      expect(params.modelKey).toBe('voyage');
      expect(params.modelId).toBe('voyage-3');
      expect(params.dimensions).toBe(1024);
      expect(params.distance).toBe('cosine');
      expect(params.metadata?.name).toBe('Voyage 3 (1024D)');
    });

    it('creates params from local Transformers metadata', () => {
      const params = createEmbeddingSetParamsFromMetadata(localMetadata);

      expect(params.modelKey).toBe('local');
      expect(params.modelId).toBe('jinaai/jina-embeddings-v2-base-code');
      expect(params.dimensions).toBe(768);
      expect(params.distance).toBe('cosine');
      expect(params.metadata?.name).toBe('Jina Code v2 (768D)');
    });

    it('applies user-provided metadata', () => {
      const params = createEmbeddingSetParamsFromMetadata(openAIMetadata, {
        category: 'development',
        description: 'For code search',
        name: 'Code Embeddings',
        tags: 'code,search',
      });

      expect(params.metadata?.name).toBe('Code Embeddings');
      expect(params.metadata?.description).toBe('For code search');
      expect(params.metadata?.tags).toBe('code,search');
      expect(params.metadata?.category).toBe('development');
    });

    it('uses default name when user provides other metadata without name', () => {
      const params = createEmbeddingSetParamsFromMetadata(openAIMetadata, {
        description: 'Custom description',
      });

      expect(params.metadata?.name).toBe('OpenAI text-embedding-3-small (1536D)');
      expect(params.metadata?.description).toBe('Custom description');
    });

    it('omits empty metadata fields (exactOptionalPropertyTypes)', () => {
      const params = createEmbeddingSetParamsFromMetadata(openAIMetadata, {
        name: 'Test',
        // description, tags, category are undefined
      });

      expect(params.metadata?.name).toBe('Test');
      expect(params.metadata?.description).toBeUndefined();
      expect(params.metadata?.tags).toBeUndefined();
      expect(params.metadata?.category).toBeUndefined();
    });
  });

  describe('validateEmbeddingDimensions', () => {
    it('validates matching dimensions for number array', () => {
      const embedding = new Array(1536).fill(0);
      const result = validateEmbeddingDimensions(embedding, 1536);
      expect(result.ok).toBe(true);
    });

    it('validates matching dimensions for Float32Array', () => {
      const embedding = new Float32Array(768);
      const result = validateEmbeddingDimensions(embedding, 768);
      expect(result.ok).toBe(true);
    });

    it('rejects dimension mismatch for number array', () => {
      const embedding = new Array(512).fill(0);
      const result = validateEmbeddingDimensions(embedding, 1024);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('dimension_mismatch');
        expect(result.error.expected).toBe(1024);
        expect(result.error.actual).toBe(512);
      }
    });

    it('rejects dimension mismatch for Float32Array', () => {
      const embedding = new Float32Array(256);
      const result = validateEmbeddingDimensions(embedding, 768);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('dimension_mismatch');
        expect(result.error.expected).toBe(768);
        expect(result.error.actual).toBe(256);
      }
    });
  });

  describe('isProviderCompatibleWithSet', () => {
    it('validates compatible provider and set', () => {
      const setConfig = {
        dimensions: 1536,
        distance: 'cosine' as const,
        modelId: 'text-embedding-3-small',
        modelKey: 'openai',
      };

      const result = isProviderCompatibleWithSet(setConfig, openAIMetadata);
      expect(result.ok).toBe(true);
    });

    it('rejects incompatible provider', () => {
      const setConfig = {
        dimensions: 1024,
        distance: 'cosine' as const,
        modelId: 'voyage-3',
        modelKey: 'voyage', // Different provider
      };

      const result = isProviderCompatibleWithSet(setConfig, openAIMetadata);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'provider_mismatch') {
        expect(result.error.expected).toBe('voyage');
        expect(result.error.provided).toBe('openai');
      } else {
        // Fail the test if we got the wrong error type
        expect(result.ok).toBe(false);
        expect((result as { ok: false; error: { type: string } }).error.type).toBe(
          'provider_mismatch'
        );
      }
    });

    it('rejects incompatible dimensions with same provider', () => {
      const setConfig = {
        dimensions: 3072, // Different dimensions
        distance: 'cosine' as const,
        modelId: 'text-embedding-3-large',
        modelKey: 'openai',
      };

      const result = isProviderCompatibleWithSet(setConfig, openAIMetadata);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'dimension_mismatch') {
        expect(result.error.expected).toBe(3072);
        expect(result.error.provided).toBe(1536);
      }
    });

    it('rejects incompatible distance metric', () => {
      const setConfig = {
        dimensions: 1536,
        distance: 'l2' as const, // Different distance
        modelId: 'text-embedding-3-small',
        modelKey: 'openai',
      };

      const result = isProviderCompatibleWithSet(setConfig, openAIMetadata);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'distance_mismatch') {
        expect(result.error.expected).toBe('l2');
        expect(result.error.provided).toBe('cosine');
      }
    });

    it('validates local provider compatibility', () => {
      const setConfig = {
        dimensions: 768,
        distance: 'cosine' as const,
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        modelKey: 'local',
      };

      const result = isProviderCompatibleWithSet(setConfig, localMetadata);
      expect(result.ok).toBe(true);
    });
  });

  describe('end-to-end validation workflow', () => {
    it('creates and validates params from metadata', () => {
      // Step 1: Get metadata from provider
      const metadata = openAIMetadata;

      // Step 2: Create params from metadata
      const params = createEmbeddingSetParamsFromMetadata(metadata, {
        name: 'My Embeddings',
      });

      // Step 3: Validate params (should always pass when created from metadata)
      const validation = validateEmbeddingSetParams(params, metadata);
      expect(validation.ok).toBe(true);

      // Step 4: Params are ready for repository.getOrCreateSet()
      expect(params.modelKey).toBe('openai');
      expect(params.modelId).toBe('text-embedding-3-small');
      expect(params.dimensions).toBe(1536);
      expect(params.distance).toBe('cosine');
      expect(params.metadata?.name).toBe('My Embeddings');
    });

    it('validates embedding dimensions before storage', () => {
      // Simulate embedding from provider
      const embedding = new Float32Array(1536).fill(0.1);

      // Validate against set dimensions
      const validation = validateEmbeddingDimensions(embedding, 1536);
      expect(validation.ok).toBe(true);
    });

    it('catches dimension mismatch before storage', () => {
      // Simulate embedding with wrong dimensions
      const embedding = new Float32Array(768).fill(0.1);

      // Validate against set expecting different dimensions
      const validation = validateEmbeddingDimensions(embedding, 1536);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.error.expected).toBe(1536);
        expect(validation.error.actual).toBe(768);
      }
    });
  });
});
