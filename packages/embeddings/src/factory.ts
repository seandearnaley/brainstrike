import type { IEmbeddingProvider } from './interfaces/provider';
import type { EmbeddingProviderConfig, EmbeddingProviderError, Result } from './provider-types';
import {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver';
import { CohereEmbeddingProvider } from './providers/hosted/cohere-provider';
import { GoogleEmbeddingProvider } from './providers/hosted/google-provider';
import { OpenAIEmbeddingProvider } from './providers/hosted/openai-provider';
import { VoyageEmbeddingProvider } from './providers/hosted/voyage-provider';
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
   * Format: "provider:modelId:variant" where variant captures runtime-specific configuration.
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
    const key = EmbeddingProviderFactory.composeCacheKey(config);

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
            // Quantization determines backend; only low-precision configs prefer WASM
            config.quantization && ['q4', 'q8'].includes(config.quantization) ? 'wasm' : 'webgpu'
          );
          break;
        }

        case 'hosted': {
          const apiKey = await resolveHostedProviderApiKey(config.provider);
          if (!apiKey) {
            return {
              ok: false,
              error: {
                type: 'missing_api_key',
                provider: config.provider,
              },
            };
          }

          switch (config.provider) {
            case 'openai': {
              provider = new OpenAIEmbeddingProvider({
                modelId: config.modelId,
                targetDimensions: config.dimensions,
                apiKey,
              });
              break;
            }

            case 'google': {
              const googleOptions: {
                modelId: string;
                apiKey: string;
                outputDimensions?: number;
              } = {
                modelId: config.modelId,
                apiKey,
              };
              if (config.outputDimensionality !== undefined) {
                googleOptions.outputDimensions = config.outputDimensionality;
              }
              provider = new GoogleEmbeddingProvider(googleOptions);
              break;
            }

            case 'cohere': {
              const cohereOptions: {
                modelId: string;
                apiKey: string;
                inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
              } = {
                modelId: config.modelId,
                apiKey,
              };
              if (config.inputType !== undefined) {
                cohereOptions.inputType = config.inputType;
              }
              provider = new CohereEmbeddingProvider(cohereOptions);
              break;
            }

            case 'voyage': {
              const voyageOptions: {
                modelId: string;
                apiKey: string;
                inputType?: 'document' | 'query';
              } = {
                modelId: config.modelId,
                apiKey,
              };
              if (config.inputType !== undefined) {
                voyageOptions.inputType = config.inputType;
              }
              provider = new VoyageEmbeddingProvider(voyageOptions);
              break;
            }

            default: {
              // TypeScript exhaustiveness check for hosted providers
              const _exhaustiveProvider: never = config;
              throw new Error(
                `Unreachable: hosted provider not handled: ${JSON.stringify(_exhaustiveProvider)}`
              );
            }
          }

          break;
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
   * @param variant - Cache variant identifier (quantization, dimension, etc.)
   * @returns Provider instance or undefined if not cached
   */
  static getCachedProvider(
    provider: string,
    modelId: string,
    variant?: string
  ): IEmbeddingProvider | undefined {
    const key = `${provider}:${modelId}:${variant ?? 'default'}`;
    return EmbeddingProviderFactory.instances.get(key);
  }

  /**
   * Remove a provider from the cache
   * Useful for forcing re-initialization or freeing resources
   *
   * @param provider - Provider type
   * @param modelId - Model ID
   * @param variant - Cache variant identifier (quantization, dimension, etc.)
   * @returns true if provider was removed, false if not found
   */
  static async removeProvider(
    provider: string,
    modelId: string,
    variant?: string
  ): Promise<boolean> {
    const key = `${provider}:${modelId}:${variant ?? 'default'}`;
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
    providers: Array<{ provider: string; modelId: string; variant: string }>;
  } {
    const providers = Array.from(EmbeddingProviderFactory.instances.keys()).map((key) => {
      const parts = key.split(':');
      const provider = parts[0] ?? '';
      const modelId = parts[1] ?? '';
      const variant = parts[2] ?? 'default';
      return { provider, modelId, variant };
    });

    return {
      size: EmbeddingProviderFactory.instances.size,
      providers,
    };
  }

  /**
   * Clear cached API keys (useful for tests)
   */
  static clearHostedApiKeyCache(provider?: Exclude<EmbeddingProviderConfig['provider'], 'local'>) {
    if (provider) {
      clearHostedProviderApiKeyCache(provider);
    } else {
      clearHostedProviderApiKeyCache();
    }
  }

  private static composeCacheKey(config: EmbeddingProviderConfig): string {
    const variant = EmbeddingProviderFactory.resolveVariant(config);
    return `${config.provider}:${config.modelId}:${variant}`;
  }

  private static resolveVariant(config: EmbeddingProviderConfig): string {
    if (config.runtime === 'browser') {
      return config.quantization ?? 'default';
    }

    switch (config.provider) {
      case 'openai': {
        return String(config.dimensions ?? 'default');
      }
      case 'google': {
        return String(config.outputDimensionality ?? 'default');
      }
      case 'cohere': {
        return config.inputType ?? 'default';
      }
      case 'voyage': {
        return config.inputType ?? 'default';
      }
      default:
        return 'default';
    }
  }
}
