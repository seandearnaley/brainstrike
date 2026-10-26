import type {
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProviderError,
  EmbeddingProviderType,
  ProviderMetadata,
  Result,
} from '../provider-types.ts';
import type { ModelConfig } from '../types.ts';

// Re-export EmbeddingInput for convenience
export type { EmbeddingInput };

/**
 * Provider interface for hosted (API-based) embedding generation
 *
 * Uses Strategy pattern to enable swapping between different embedding backends
 * without changing consumer code.
 */
export interface IEmbeddingProvider {
  /**
   * Generate embedding for given text
   * Returns a Result type for explicit error handling (no thrown exceptions)
   *
   * @param input - Text and model ID for embedding generation
   * @returns Result with embedding output or typed error
   */
  embed: (input: EmbeddingInput) => Promise<Result<EmbeddingOutput, EmbeddingProviderError>>;

  /**
   * Get unified provider metadata for embedding-set creation and validation (BST-167)
   * Returns metadata about the current provider including dimensions and distance metric
   *
   * @param modelId - Model identifier to get metadata for
   * @returns Provider metadata or null if model not found/configured
   */
  getMetadata: (modelId: string) => ProviderMetadata | null;

  /**
   * Get model metadata from registry
   * Returns null if model not found
   *
   * @param modelId - Model identifier
   * @returns Model configuration or null if not found
   */
  getModelInfo: (modelId: string) => ModelConfig | null;

  /**
   * Check if API key is configured
   */
  hasApiKey: () => boolean;

  /**
   * Check if provider is available and ready to generate embeddings:
   * API reachability and API key presence
   *
   * @returns true if provider is ready or can be initialized
   */
  isAvailable: () => Promise<boolean>;

  readonly provider: EmbeddingProviderType;

  /**
   * Set API key for the provider
   * Allows updating credentials without recreating provider instance
   *
   * @param apiKey - API key for the provider
   */
  setApiKey: (apiKey: string) => void;

  /**
   * Validate embedding dimensions match expected value
   * Critical for ensuring embeddings are compatible with database schema
   *
   * @param embedding - Embedding vector to validate
   * @param expectedDimensions - Expected dimension count (typically 768)
   * @returns Result with void on success or dimension_mismatch error
   */
  validateDimensions: (
    embedding: number[],
    expectedDimensions: number
  ) => Result<void, EmbeddingProviderError>;
}
