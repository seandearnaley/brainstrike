import type {
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProviderError,
  EmbeddingProviderType,
  Result,
} from '../provider-types';
import type { ModelConfig } from '../types';

// Re-export EmbeddingInput for convenience
export type { EmbeddingInput };

/**
 * Provider interface for embedding generation
 * Supports both local (transformers.js) and hosted (API-based) providers
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
  embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>>;

  /**
   * Check if provider is available and ready to generate embeddings
   * - Local providers: Check if model is loaded or can be loaded
   * - Hosted providers: Check API reachability and API key presence
   *
   * @returns true if provider is ready or can be initialized
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get model metadata from registry
   * Returns null if model not found
   *
   * @param modelId - Model identifier
   * @returns Model configuration or null if not found
   */
  getModelInfo(modelId: string): ModelConfig | null;

  /**
   * Validate embedding dimensions match expected value
   * Critical for ensuring embeddings are compatible with database schema
   *
   * @param embedding - Embedding vector to validate
   * @param expectedDimensions - Expected dimension count (typically 768)
   * @returns Result with void on success or dimension_mismatch error
   */
  validateDimensions(
    embedding: number[],
    expectedDimensions: number
  ): Result<void, EmbeddingProviderError>;
}

/**
 * Extended provider interface for local (transformers.js) providers
 * Adds lifecycle methods specific to browser-based embedding models
 */
export interface ILocalEmbeddingProvider extends IEmbeddingProvider {
  /**
   * Provider type discriminator
   */
  readonly runtime: 'browser';
  readonly provider: 'local';

  /**
   * Initialize the local model with progress tracking
   * Only needed for local providers that load models into memory
   *
   * @param onProgress - Optional callback for download/initialization progress
   */
  initialize(onProgress?: (progress: { stage: string; progress?: number }) => void): Promise<void>;

  /**
   * Dispose of loaded model and free resources
   * Important for memory management in browser environments
   */
  dispose(): Promise<void>;

  /**
   * Get current initialization status
   */
  getStatus(): 'idle' | 'initializing' | 'ready' | 'error';
}

/**
 * Extended provider interface for hosted (API-based) providers
 * Adds configuration specific to API-based embedding services
 */
export interface IHostedEmbeddingProvider extends IEmbeddingProvider {
  /**
   * Provider type discriminator
   */
  readonly runtime: 'hosted';
  readonly provider: Exclude<EmbeddingProviderType, 'local'>;

  /**
   * Set API key for the provider
   * Allows updating credentials without recreating provider instance
   *
   * @param apiKey - API key for the provider
   */
  setApiKey(apiKey: string): void;

  /**
   * Check if API key is configured
   */
  hasApiKey(): boolean;
}
