import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingProviderFactory } from '../factory';
import type { ILocalEmbeddingProvider } from '../interfaces/provider';
import type { EmbeddingProviderConfig } from '../provider-types';

describe('EmbeddingProviderFactory', () => {
  beforeEach(async () => {
    // Clear cache before each test
    await EmbeddingProviderFactory.clearCache();
  });

  afterEach(async () => {
    // Clean up after each test
    await EmbeddingProviderFactory.clearCache();
  });

  describe('local provider creation', () => {
    it('creates a local provider instance', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        const provider = result.value as ILocalEmbeddingProvider;
        expect(provider.runtime).toBe('browser');
        expect(provider.provider).toBe('local');
      }
    });

    it('creates provider with quantization config', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
        quantization: 'q8',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    it('returns cached instance for same config', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config);
      const result2 = await EmbeddingProviderFactory.createProvider(config);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be the same instance
        expect(result1.value).toBe(result2.value);
      }
    });

    it('creates different instances for different models', async () => {
      const config1: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
      };

      const result1 = await EmbeddingProviderFactory.createProvider(config1);
      const result2 = await EmbeddingProviderFactory.createProvider(config2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be different instances
        expect(result1.value).not.toBe(result2.value);
      }
    });
  });

  describe('hosted provider creation', () => {
    it('returns error for hosted providers (not yet implemented)', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'hosted',
        provider: 'openai',
        modelId: 'text-embedding-3-small',
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('validation_error');
        if (result.error.type === 'validation_error') {
          expect(result.error.message).toContain('not yet implemented');
        }
      }
    });
  });

  describe('cache management', () => {
    it('getCachedProvider returns cached instance', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const createResult = await EmbeddingProviderFactory.createProvider(config);
      expect(createResult.ok).toBe(true);

      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code');
      expect(cached).toBeDefined();

      if (createResult.ok) {
        expect(cached).toBe(createResult.value);
      }
    });

    it('getCachedProvider returns undefined for non-existent provider', () => {
      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'nonexistent');
      expect(cached).toBeUndefined();
    });

    it('removeProvider removes from cache', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      await EmbeddingProviderFactory.createProvider(config);

      const removed = await EmbeddingProviderFactory.removeProvider('local', 'jina-code');
      expect(removed).toBe(true);

      const cached = EmbeddingProviderFactory.getCachedProvider('local', 'jina-code');
      expect(cached).toBeUndefined();
    });

    it('removeProvider returns false for non-existent provider', async () => {
      const removed = await EmbeddingProviderFactory.removeProvider('local', 'nonexistent');
      expect(removed).toBe(false);
    });

    it('clearCache removes all providers', async () => {
      const config1: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
      };

      await EmbeddingProviderFactory.createProvider(config1);
      await EmbeddingProviderFactory.createProvider(config2);

      const statsBefore = EmbeddingProviderFactory.getCacheStats();
      expect(statsBefore.size).toBe(2);

      await EmbeddingProviderFactory.clearCache();

      const statsAfter = EmbeddingProviderFactory.getCacheStats();
      expect(statsAfter.size).toBe(0);
      expect(statsAfter.providers).toEqual([]);
    });

    it('getCacheStats returns correct statistics', async () => {
      const config1: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const config2: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'bge-base-en-v1.5',
      };

      await EmbeddingProviderFactory.createProvider(config1);
      await EmbeddingProviderFactory.createProvider(config2);

      const stats = EmbeddingProviderFactory.getCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.providers).toHaveLength(2);
      expect(stats.providers).toEqual(
        expect.arrayContaining([
          { provider: 'local', modelId: 'jina-code' },
          { provider: 'local', modelId: 'bge-base-en-v1.5' },
        ])
      );
    });
  });

  describe('provider interface conformance', () => {
    it('created provider implements IEmbeddingProvider', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const provider = result.value;

        // Check interface methods exist
        expect(typeof provider.embed).toBe('function');
        expect(typeof provider.isAvailable).toBe('function');
        expect(typeof provider.getModelInfo).toBe('function');
        expect(typeof provider.validateDimensions).toBe('function');
      }
    });

    it('local provider implements ILocalEmbeddingProvider', async () => {
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'jina-code',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const provider = result.value as ILocalEmbeddingProvider;

        // Check extended interface methods exist
        expect(typeof provider.initialize).toBe('function');
        expect(typeof provider.dispose).toBe('function');
        expect(typeof provider.getStatus).toBe('function');

        // Check discriminators
        expect(provider.runtime).toBe('browser');
        expect(provider.provider).toBe('local');
      }
    });
  });

  describe('error handling', () => {
    it('creates provider successfully (errors happen during usage)', async () => {
      // Factory doesn't validate model IDs upfront - providers are created successfully
      // and errors only occur during initialization/usage
      const config: EmbeddingProviderConfig = {
        runtime: 'browser',
        provider: 'local',
        modelId: 'potentially-invalid-model',
      };

      const result = await EmbeddingProviderFactory.createProvider(config);

      // Provider creation succeeds
      expect(result.ok).toBe(true);

      // Errors would occur later when calling embed() or initialize()
      if (result.ok) {
        const provider = result.value as ILocalEmbeddingProvider;
        expect(provider).toBeDefined();

        // Try to check availability (this will attempt initialization)
        const available = await provider.isAvailable();
        // May or may not be available depending on the model
        expect(typeof available).toBe('boolean');
      }
    });
  });
});
