import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

/**
 * Default embedding dimension (768D)
 * Note: This is no longer a hard constraint. Dimensions from 256-1536 are supported.
 */
export const STANDARD_EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSION;

/**
 * Supported embedding provider types
 * Note: 'transformers' is an alias for 'local' (both use transformers.js in the browser)
 * The database uses 'transformers' as the provider_id for local models
 */
export type EmbeddingProviderType =
  | 'local'
  | 'transformers'
  | 'openai'
  | 'google'
  | 'cohere'
  | 'voyage'
  | 'ollama'
  | 'lmstudio';

/**
 * Local provider types that run in the browser via transformers.js
 */
export type LocalProviderType = 'local' | 'transformers';

/**
 * Hosted provider types (remote APIs and local OpenAI-compatible runtimes)
 */
export type HostedProviderType = Exclude<EmbeddingProviderType, LocalProviderType>;

const NO_API_KEY_HOSTED_PROVIDERS = new Set<HostedProviderType>(['ollama', 'lmstudio']);

/**
 * Hosted providers that require an API key to operate.
 */
export function hostedProviderRequiresApiKey(provider: HostedProviderType): boolean {
  return !NO_API_KEY_HOSTED_PROVIDERS.has(provider);
}

/**
 * Check if a provider type is a local (browser-based) provider
 */
export function isLocalProviderType(
  provider: EmbeddingProviderType
): provider is LocalProviderType {
  return provider === 'local' || provider === 'transformers';
}

/**
 * Provider runtime classification
 */
export type EmbeddingRuntime = 'browser' | 'hosted';

/**
 * Discriminated union for embedding provider configurations
 * Each provider has its specific configuration shape
 */
export type EmbeddingProviderConfig =
  | {
      runtime: 'browser';
      provider: 'local';
      modelId: string; // e.g., 'jina-code', 'bge-base-en-v1.5'
      quantization?: 'q4' | 'q8' | 'fp16';
    }
  | {
      runtime: 'hosted';
      provider: 'openai';
      modelId: string; // e.g., 'text-embedding-3-small'
      dimensions: number; // Configurable dimensions (256-1536 supported)
    }
  | {
      runtime: 'hosted';
      provider: 'google';
      modelId: string; // e.g., 'gemini-embedding-001'
      outputDimensionality?: number; // Optional, defaults to model's native dimensions
    }
  | {
      runtime: 'hosted';
      provider: 'cohere';
      modelId: string; // e.g., 'embed-english-v3.0'
      inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
    }
  | {
      runtime: 'hosted';
      provider: 'voyage';
      modelId: string; // e.g., 'voyage-2'
      inputType?: 'document' | 'query';
    }
  | {
      runtime: 'hosted';
      provider: 'ollama';
      modelId: string; // e.g., 'nomic-embed-text'
      dimensions: number; // Expected output dimensions from embedding set metadata
      endpoint?: string; // Optional custom endpoint (defaults to localhost Ollama)
    }
  | {
      runtime: 'hosted';
      provider: 'lmstudio';
      modelId: string; // e.g., 'text-embedding-nomic-embed-text-v1.5'
      dimensions: number; // Expected output dimensions from embedding set metadata
      endpoint?: string; // Optional custom endpoint (defaults to localhost LM Studio)
    };

/**
 * Discriminated union for embedding operation errors
 * Enables type-safe error handling without exceptions
 */
export type EmbeddingProviderError =
  | {
      type: 'dimension_mismatch';
      expected: number;
      received: number;
      modelId: string;
    }
  | {
      type: 'api_error';
      provider: HostedProviderType;
      statusCode: number;
      message: string;
    }
  | {
      type: 'model_load_failed';
      provider: LocalProviderType;
      modelId: string;
      reason: string;
    }
  | {
      type: 'missing_api_key';
      provider: HostedProviderType;
    }
  | {
      type: 'network_error';
      provider: HostedProviderType;
      originalError: Error;
    }
  | {
      type: 'rate_limit_exceeded';
      provider: HostedProviderType;
      retryAfter?: number;
    }
  | {
      type: 'validation_error';
      field: string;
      message: string;
    };

/**
 * Result type for type-safe error handling
 * Replaces thrown exceptions with explicit error states
 */
export type Result<T, E = EmbeddingProviderError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Input for embedding generation
 */
export interface EmbeddingInput {
  modelId: string;
  text: string | string[];
}

/**
 * Distance/similarity metric used for vector comparison
 */
export type DistanceMetric = 'cosine' | 'l2' | 'ip';

/**
 * Unified provider metadata for both local and hosted providers
 * Used for embedding-set creation and validation (BST-167)
 */
export interface ProviderMetadata {
  /** Optional context window size */
  contextWindow?: number;
  /** Expected embedding dimensions */
  dimensions: number;
  /** Optional display name for the model */
  displayName?: string;
  /** Distance metric for similarity calculations (defaults to 'cosine') */
  distance: DistanceMetric;
  /** Model key/identifier used for embedding generation */
  modelKey: string;
  /** Provider identifier (e.g., 'local', 'openai', 'google', 'cohere', 'voyage') */
  providerId: EmbeddingProviderType;
}

/**
 * Output from embedding generation
 */
export interface EmbeddingOutput {
  dimensions: number;
  /** Distance metric used (defaults to 'cosine') */
  distance?: DistanceMetric;
  embedding: number[];
  embeddings?: number[][];
  modelId: string;
  provider: EmbeddingProviderType;
  usage?: {
    inputTokens: number;
    totalTokens?: number;
  };
}
