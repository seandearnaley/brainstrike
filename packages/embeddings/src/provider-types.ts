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
  | 'voyage';

/**
 * Local provider types that run in the browser via transformers.js
 */
export type LocalProviderType = 'local' | 'transformers';

/**
 * Hosted provider types that require API keys
 */
export type HostedProviderType = Exclude<EmbeddingProviderType, LocalProviderType>;

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
      modelId: string; // e.g., 'text-embedding-004'
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
  text: string | string[];
  modelId: string;
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
  /** Provider identifier (e.g., 'local', 'openai', 'google', 'cohere', 'voyage') */
  providerId: EmbeddingProviderType;
  /** Model key/identifier used for embedding generation */
  modelKey: string;
  /** Expected embedding dimensions */
  dimensions: number;
  /** Distance metric for similarity calculations (defaults to 'cosine') */
  distance: DistanceMetric;
  /** Optional display name for the model */
  displayName?: string;
  /** Optional context window size */
  contextWindow?: number;
}

/**
 * Output from embedding generation
 */
export interface EmbeddingOutput {
  embedding: number[];
  embeddings?: number[][];
  dimensions: number;
  modelId: string;
  provider: EmbeddingProviderType;
  /** Distance metric used (defaults to 'cosine') */
  distance?: DistanceMetric;
  usage?: {
    inputTokens: number;
    totalTokens?: number;
  };
}
