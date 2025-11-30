import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';

/**
 * Default embedding dimension (768D)
 * Note: This is no longer a hard constraint. Dimensions from 256-1536 are supported.
 */
export const STANDARD_EMBEDDING_DIMENSION = DEFAULT_EMBEDDING_DIMENSION;

/**
 * Supported embedding provider types
 */
export type EmbeddingProviderType = 'local' | 'openai' | 'google' | 'cohere' | 'voyage';

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
      provider: Exclude<EmbeddingProviderType, 'local'>;
      statusCode: number;
      message: string;
    }
  | {
      type: 'model_load_failed';
      provider: 'local';
      modelId: string;
      reason: string;
    }
  | {
      type: 'missing_api_key';
      provider: Exclude<EmbeddingProviderType, 'local'>;
    }
  | {
      type: 'network_error';
      provider: Exclude<EmbeddingProviderType, 'local'>;
      originalError: Error;
    }
  | {
      type: 'rate_limit_exceeded';
      provider: Exclude<EmbeddingProviderType, 'local'>;
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
export type EmbeddingInput = {
  text: string | string[];
  modelId: string;
};

/**
 * Output from embedding generation
 */
export type EmbeddingOutput = {
  embedding: number[];
  embeddings?: number[][];
  dimensions: number;
  modelId: string;
  provider: EmbeddingProviderType;
  usage?: {
    inputTokens: number;
    totalTokens?: number;
  };
};
