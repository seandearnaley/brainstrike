import type { IEmbeddingProvider } from './interfaces/provider.ts';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderType,
  Result,
} from './provider-types.ts';
import {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver.ts';
import { CohereEmbeddingProvider } from './providers/hosted/cohere-provider.ts';
import { GoogleEmbeddingProvider } from './providers/hosted/google-provider.ts';
import { OpenAIEmbeddingProvider } from './providers/hosted/openai-provider.ts';
import { VoyageEmbeddingProvider } from './providers/hosted/voyage-provider.ts';

/**
 * Custom error for missing API keys that preserves provider information
 */
class MissingApiKeyError extends Error {
  readonly provider: EmbeddingProviderType;
  readonly errorType = 'missing_api_key' as const;

  constructor(provider: EmbeddingProviderType) {
    super(`Missing API key for ${provider} provider`);
    this.provider = provider;
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Factory for creating embedding provider instances
 * Implements Factory pattern to abstract provider creation and lifecycle management
 *
 * Features:
 * - Instance caching per provider, model and configuration variant
 * - Type-safe error handling with Result pattern
 *
 * Note: Using class with static members is intentional for Factory pattern
 * to maintain private state (instances Map) and provide clear namespace.
 */
export class EmbeddingProviderFactory {
  /**
   * Cache of provider instances keyed by composite ID
   * Format: "provider:modelId:variant" where variant captures provider-specific configuration.
   */
  private static readonly instances = new Map<string, IEmbeddingProvider>();

  /**
   * Create or retrieve a cached embedding provider instance
   *
   * @param config - Provider configuration (discriminated union)
   * @returns Result with provider instance or typed error
   *
   * @example
   * ```typescript
   * const result = await EmbeddingProviderFactory.createProvider({
   *   provider: 'openai',
   *   modelId: 'text-embedding-3-small',
   *   dimensions: 1536,
   * });
   *
   * if (result.ok) {
   *   const embedding = await result.value.embed({
   *     text: 'hello',
   *     modelId: 'text-embedding-3-small',
   *   });
   * }
   * ```
   */
  static async createProvider(
    config: EmbeddingProviderConfig
  ): Promise<Result<IEmbeddingProvider, EmbeddingProviderError>> {
    const apiKey = await resolveHostedProviderApiKey(config.provider);
    const key = EmbeddingProviderFactory.composeCacheKey(config);

    // Return cached instance if exists
    const cached = EmbeddingProviderFactory.instances.get(key);
    if (cached) {
      return { ok: true, value: cached };
    }

    try {
      const provider = EmbeddingProviderFactory.instantiateProvider(config, apiKey);

      // Cache the instance
      EmbeddingProviderFactory.instances.set(key, provider);

      return { ok: true, value: provider };
    } catch (error) {
      // Check if this is a missing API key error
      if (error instanceof MissingApiKeyError) {
        return {
          error: {
            provider: error.provider,
            type: 'missing_api_key',
          },
          ok: false,
        };
      }

      return {
        error: {
          field: 'modelId',
          message: error instanceof Error ? error.message : String(error),
          type: 'validation_error',
        },
        ok: false,
      };
    }
  }

  /**
   * Instantiate a provider based on configuration (extracted for complexity reduction)
   */
  private static instantiateProvider(
    config: EmbeddingProviderConfig,
    apiKey: string | undefined
  ): IEmbeddingProvider {
    if (!apiKey) {
      throw new MissingApiKeyError(config.provider);
    }

    switch (config.provider) {
      case 'openai':
        return new OpenAIEmbeddingProvider({
          apiKey,
          modelId: config.modelId,
          targetDimensions: config.dimensions,
        });

      case 'google': {
        const options: { modelId: string; apiKey: string; outputDimensions?: number } = {
          apiKey,
          modelId: config.modelId,
        };
        if (config.outputDimensionality !== undefined) {
          options.outputDimensions = config.outputDimensionality;
        }
        return new GoogleEmbeddingProvider(options);
      }

      case 'cohere': {
        const options: {
          modelId: string;
          apiKey: string;
          inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
        } = {
          apiKey,
          modelId: config.modelId,
        };
        if (config.inputType !== undefined) {
          options.inputType = config.inputType;
        }
        return new CohereEmbeddingProvider(options);
      }

      case 'voyage': {
        const options: { modelId: string; apiKey: string; inputType?: 'document' | 'query' } = {
          apiKey,
          modelId: config.modelId,
        };
        if (config.inputType !== undefined) {
          options.inputType = config.inputType;
        }
        return new VoyageEmbeddingProvider(options);
      }

      default: {
        const _exhaustive: never = config;
        throw new Error(`Unreachable: provider not handled: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Get a cached provider instance if it exists
   *
   * @param provider - Provider type
   * @param modelId - Model ID
   * @param variant - Cache variant identifier (dimensions or input type)
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
   * @param variant - Cache variant identifier (dimensions or input type)
   * @returns true if provider was removed, false if not found
   */
  static async removeProvider(
    provider: string,
    modelId: string,
    variant?: string
  ): Promise<boolean> {
    const key = `${provider}:${modelId}:${variant ?? 'default'}`;
    return EmbeddingProviderFactory.instances.delete(key);
  }

  /**
   * Clear all cached providers
   * Useful for cleanup or forcing re-initialization
   */
  static async clearCache(): Promise<void> {
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
      return { modelId, provider, variant };
    });

    return {
      providers,
      size: EmbeddingProviderFactory.instances.size,
    };
  }

  /**
   * Clear cached API keys (useful for tests)
   */
  static clearHostedApiKeyCache(provider?: EmbeddingProviderType) {
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
