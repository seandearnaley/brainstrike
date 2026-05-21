export type {
  DistanceMetric,
  EmbeddingProviderType,
  EmbeddingRuntime,
  HostedProviderType,
  LocalProviderType,
  ProviderMetadata,
} from '@brainstrike/indexing-contract';
export {
  hostedProviderRequiresApiKey,
  isLocalProviderType,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/indexing-contract';

import type {
  DistanceMetric,
  EmbeddingProviderType,
  HostedProviderType,
  LocalProviderType,
} from '@brainstrike/indexing-contract';

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
