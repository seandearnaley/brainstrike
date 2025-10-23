import type { IEmbeddingProvider } from './interfaces/provider';
import type { EmbeddingProviderConfig, EmbeddingProviderError, Result } from './provider-types';
import { TransformersEmbeddingProvider } from './providers/local/transformers-provider';

/**
 * Factory for creating embedding provider instances
 * Implements Factory pattern to abstract provider creation and lifecycle management
 *
 * Features:
 * - Instance caching to avoid duplicate model loading
 * - Type-safe error handling with Result pattern
 * - Support for both local and hosted providers (hosted providers in Phase 4)
 *
 * Note: Using class with static members is intentional for Factory pattern
 * to maintain private state (instances Map) and provide clear namespace.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Factory pattern with private state
export class EmbeddingProviderFactory {
  /**
   * Cache of provider instances keyed by composite ID
   * Format: "provider:modelId:quantization" (e.g., "local:jina-code:q8", "local:jina-code:default")
   * Note: Quantization affects device selection, so it must be part of the cache key
   */
  private static instances = new Map<string, IEmbeddingProvider>();

  /**
   * Create or retrieve a cached embedding provider instance
   *
   * @param config - Provider configuration (discriminated union)
   * @returns Result with provider instance or typed error
   *
   * @example
   * ```typescript
   * // Local provider
   * const result = await EmbeddingProviderFactory.createProvider({
   *   runtime: 'browser',
   *   provider: 'local',
   *   modelId: 'jina-code',
   * });
   *
   * if (result.ok) {
   *   const embedding = await result.value.embed({ text: 'hello', modelId: 'jina-code' });
   * }
   * ```
   */
  static async createProvider(
    config: EmbeddingProviderConfig
  ): Promise<Result<IEmbeddingProvider, EmbeddingProviderError>> {
    // Include quantization in cache key since it affects device selection
    const quantization = config.runtime === 'browser' ? config.quantization || 'default' : 'n/a';
    const key = `${config.provider}:${config.modelId}:${quantization}`;

    // Return cached instance if exists
    const cached = EmbeddingProviderFactory.instances.get(key);
    if (cached) {
      return { ok: true, value: cached };
    }

    try {
      let provider: IEmbeddingProvider;

      // Use discriminated union to create appropriate provider
      switch (config.runtime) {
        case 'browser': {
          // Local provider using transformers.js
          provider = new TransformersEmbeddingProvider(
            config.modelId,
            // Map quantization to device preference (quantized models may prefer different backends)
            config.quantization ? 'wasm' : 'webgpu'
          );
          break;
        }

        case 'hosted': {
          // Hosted providers will be implemented in Phase 4
          return {
            ok: false,
            error: {
              type: 'validation_error',
              field: 'provider',
              message: `Hosted provider "${config.provider}" not yet implemented. Coming in Phase 4.`,
            },
          };
        }

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = config;
          return {
            ok: false,
            error: {
              type: 'validation_error',
              field: 'runtime',
              message: `Unknown runtime: ${(_exhaustive as EmbeddingProviderConfig).runtime}`,
            },
          };
        }
      }

      // Cache the instance
      EmbeddingProviderFactory.instances.set(key, provider);

      return { ok: true, value: provider };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'model_load_failed',
          provider: config.provider as 'local', // Only local provider is supported in Phase 2
          modelId: config.modelId,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Get a cached provider instance if it exists
   *
   * @param provider - Provider type
   * @param modelId - Model ID
   * @param quantization - Quantization setting (optional, defaults to 'default')
   * @returns Provider instance or undefined if not cached
   */
  static getCachedProvider(
    provider: string,
    modelId: string,
    quantization?: string
  ): IEmbeddingProvider | undefined {
    const quant = quantization || 'default';
    const key = `${provider}:${modelId}:${quant}`;
    return EmbeddingProviderFactory.instances.get(key);
  }

  /**
   * Remove a provider from the cache
   * Useful for forcing re-initialization or freeing resources
   *
   * @param provider - Provider type
   * @param modelId - Model ID
   * @param quantization - Quantization setting (optional, defaults to 'default')
   * @returns true if provider was removed, false if not found
   */
  static async removeProvider(
    provider: string,
    modelId: string,
    quantization?: string
  ): Promise<boolean> {
    const quant = quantization || 'default';
    const key = `${provider}:${modelId}:${quant}`;
    const instance = EmbeddingProviderFactory.instances.get(key);

    if (!instance) {
      return false;
    }

    // Dispose if it's a local provider
    if ('dispose' in instance && typeof instance.dispose === 'function') {
      try {
        await instance.dispose();
      } catch (error) {
        console.warn(`Failed to dispose provider ${key}:`, error);
      }
    }

    return EmbeddingProviderFactory.instances.delete(key);
  }

  /**
   * Clear all cached providers
   * Useful for cleanup or forcing re-initialization
   */
  static async clearCache(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    for (const [key, instance] of EmbeddingProviderFactory.instances.entries()) {
      // Dispose if it's a local provider
      if ('dispose' in instance && typeof instance.dispose === 'function') {
        disposePromises.push(
          instance.dispose().catch((error: unknown) => {
            console.warn(`Failed to dispose provider ${key}:`, error);
          })
        );
      }
    }

    // Wait for all disposals to complete
    await Promise.all(disposePromises);

    // Clear the cache
    EmbeddingProviderFactory.instances.clear();
  }

  /**
   * Get cache statistics
   * Useful for debugging and monitoring
   */
  static getCacheStats(): {
    size: number;
    providers: Array<{ provider: string; modelId: string; quantization: string }>;
  } {
    const providers = Array.from(EmbeddingProviderFactory.instances.keys()).map((key) => {
      const parts = key.split(':');
      const provider = parts[0] ?? '';
      const modelId = parts[1] ?? '';
      const quantization = parts[2] ?? 'default';
      return { provider, modelId, quantization };
    });

    return {
      size: EmbeddingProviderFactory.instances.size,
      providers,
    };
  }
}
