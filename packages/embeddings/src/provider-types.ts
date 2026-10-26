export type {
  DistanceMetric,
  EmbeddingProviderType,
  ProviderMetadata,
} from '@brainstrike/indexing-contract';
export { STANDARD_EMBEDDING_DIMENSION } from '@brainstrike/indexing-contract';

import type { DistanceMetric, EmbeddingProviderType } from '@brainstrike/indexing-contract';

/**
 * Discriminated union for embedding provider configurations
 * Each provider has its specific configuration shape
 */
export type EmbeddingProviderConfig =
  | {
      provider: 'openai';
      modelId: string; // e.g., 'text-embedding-3-small'
      dimensions: number; // Configurable dimensions (256-1536 supported)
    }
  | {
      provider: 'google';
      modelId: string; // e.g., 'gemini-embedding-001'
      outputDimensionality?: number; // Optional, defaults to model's native dimensions
    }
  | {
      provider: 'cohere';
      modelId: string; // e.g., 'embed-english-v3.0'
      inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
    }
  | {
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
      provider: EmbeddingProviderType;
      statusCode: number;
      message: string;
    }
  | {
      type: 'missing_api_key';
      provider: EmbeddingProviderType;
    }
  | {
      type: 'network_error';
      provider: EmbeddingProviderType;
      originalError: Error;
    }
  | {
      type: 'rate_limit_exceeded';
      provider: EmbeddingProviderType;
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
  readonly signal?: AbortSignal;
  text: string | string[];
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
