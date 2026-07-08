import { createLogger } from '@brainstrike/utils';
import type { IEmbeddingProvider } from './interfaces/provider';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  HostedProviderType,
  Result,
} from './provider-types';
import { hostedProviderRequiresApiKey, type LocalProviderType } from './provider-types';
import {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver';
import { CohereEmbeddingProvider } from './providers/hosted/cohere-provider';
import { GoogleEmbeddingProvider } from './providers/hosted/google-provider';
import { OpenAIEmbeddingProvider } from './providers/hosted/openai-provider';
import { VoyageEmbeddingProvider } from './providers/hosted/voyage-provider';
import { TransformersEmbeddingProvider } from './providers/local/transformers-provider';

const logger = createLogger('EmbeddingProviderFactory');

/**
 * Custom error for missing API keys that preserves provider information
 */
class MissingApiKeyError extends Error {
  readonly provider: HostedProviderType;
  readonly errorType = 'missing_api_key' as const;

  constructor(provider: HostedProviderType) {
    super(`Missing API key for ${provider} provider`);
    this.provider = provider;
    this.name = 'MissingApiKeyError';
  }
}

const DEFAULT_LOCAL_RUNTIME_EMBEDDING_ENDPOINTS = {
  lmstudio: 'http://localhost:1234/v1/embeddings',
  ollama: 'http://127.0.0.1:11434/v1/embeddings',
} as const;

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
    const hostedApiKey =
      config.runtime === 'hosted' ? await resolveHostedProviderApiKey(config.provider) : null;
    const key = EmbeddingProviderFactory.composeCacheKey(config, hostedApiKey);

    // Return cached instance if exists
    const cached = EmbeddingProviderFactory.instances.get(key);
    if (cached) {
      return { ok: true, value: cached };
    }

    try {
      const provider = await EmbeddingProviderFactory.instantiateProvider(config, hostedApiKey);

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
          modelId: config.modelId,
          provider: config.provider as LocalProviderType,
          reason: error instanceof Error ? error.message : String(error),
          type: 'model_load_failed',
        },
        ok: false,
      };
    }
  }

  /**
   * Instantiate a provider based on configuration (extracted for complexity reduction)
   */
  private static async instantiateProvider(
    config: EmbeddingProviderConfig,
    hostedApiKey: string | null = null
  ): Promise<IEmbeddingProvider> {
    switch (config.runtime) {
      case 'browser':
        return new TransformersEmbeddingProvider(
          config.modelId,
          config.quantization && ['q4', 'q8'].includes(config.quantization) ? 'wasm' : 'webgpu'
        );

      case 'hosted':
        return EmbeddingProviderFactory.createHostedProvider(config, hostedApiKey);

      default: {
        const _exhaustive: never = config;
        throw new Error(`Unknown runtime: ${(_exhaustive as EmbeddingProviderConfig).runtime}`);
      }
    }
  }

  /**
   * Create a hosted provider instance (extracted for complexity reduction)
   */
  private static async createHostedProvider(
    config: Extract<EmbeddingProviderConfig, { runtime: 'hosted' }>,
    hostedApiKey: string | null = null
  ): Promise<IEmbeddingProvider> {
    const apiKey = hostedApiKey ?? (await resolveHostedProviderApiKey(config.provider));
    if (hostedProviderRequiresApiKey(config.provider) && !apiKey) {
      throw new MissingApiKeyError(config.provider);
    }
    const requireApiKey = (provider: HostedProviderType): string => {
      if (!apiKey) {
        throw new MissingApiKeyError(provider);
      }
      return apiKey;
    };

    switch (config.provider) {
      case 'openai':
        return new OpenAIEmbeddingProvider({
          apiKey: requireApiKey('openai'),
          modelId: config.modelId,
          targetDimensions: config.dimensions,
        });

      case 'google': {
        const options: { modelId: string; apiKey: string; outputDimensions?: number } = {
          apiKey: requireApiKey('google'),
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
          apiKey: requireApiKey('cohere'),
          modelId: config.modelId,
        };
        if (config.inputType !== undefined) {
          options.inputType = config.inputType;
        }
        return new CohereEmbeddingProvider(options);
      }

      case 'voyage': {
        const options: { modelId: string; apiKey: string; inputType?: 'document' | 'query' } = {
          apiKey: requireApiKey('voyage'),
          modelId: config.modelId,
        };
        if (config.inputType !== undefined) {
          options.inputType = config.inputType;
        }
        return new VoyageEmbeddingProvider(options);
      }
      case 'ollama':
      case 'lmstudio': {
        const endpoint =
          config.endpoint ?? DEFAULT_LOCAL_RUNTIME_EMBEDDING_ENDPOINTS[config.provider];
        return new OpenAIEmbeddingProvider({
          endpoint,
          modelId: config.modelId,
          provider: config.provider,
          targetDimensions: config.dimensions,
          ...(apiKey ? { apiKey } : {}),
          includeDimensions: false,
          requiresApiKey: false,
        });
      }

      default: {
        const _exhaustive: never = config;
        throw new Error(`Unreachable: hosted provider not handled: ${JSON.stringify(_exhaustive)}`);
      }
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
        logger.warn(`Failed to dispose provider ${key}`, { error });
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
            logger.warn(`Failed to dispose provider ${key}`, { error });
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
  static clearHostedApiKeyCache(
    provider?: Exclude<EmbeddingProviderConfig['provider'], LocalProviderType>
  ) {
    if (provider) {
      clearHostedProviderApiKeyCache(provider);
    } else {
      clearHostedProviderApiKeyCache();
    }
  }

  private static composeCacheKey(
    config: EmbeddingProviderConfig,
    hostedApiKey: string | null = null
  ): string {
    const variant = EmbeddingProviderFactory.resolveVariant(config, hostedApiKey);
    return `${config.provider}:${config.modelId}:${variant}`;
  }

  private static resolveVariant(
    config: EmbeddingProviderConfig,
    hostedApiKey: string | null = null
  ): string {
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
      case 'ollama':
      case 'lmstudio': {
        const endpoint =
          config.endpoint ?? DEFAULT_LOCAL_RUNTIME_EMBEDDING_ENDPOINTS[config.provider];
        const keyHash = hostedApiKey === null ? 'none' : `key_${hashVariantToken(hostedApiKey)}`;
        const dimensionsVariant =
          typeof config.dimensions === 'number' &&
          Number.isFinite(config.dimensions) &&
          config.dimensions > 0
            ? String(config.dimensions)
            : 'auto';
        return `${dimensionsVariant}:${endpoint}:${keyHash}`;
      }
      default:
        return 'default';
    }
  }
}

function hashVariantToken(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
