import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { SimpleEmbeddingService } from '../../bge-m3-service';
import type { EmbeddingInput, ILocalEmbeddingProvider } from '../../interfaces/provider';
import type { EmbeddingOutput, EmbeddingProviderError, Result } from '../../provider-types';
import type { EmbeddingProgress, ModelConfig } from '../../types';

/**
 * Local embedding provider using transformers.js
 * Wraps the existing SimpleEmbeddingService with the new provider interface
 *
 * Implements Result pattern for error handling instead of thrown exceptions
 */
export class TransformersEmbeddingProvider implements ILocalEmbeddingProvider {
  readonly runtime = 'browser' as const;
  readonly provider = 'local' as const;

  private service: SimpleEmbeddingService;
  private modelKey: string;

  /**
   * Create a new local embedding provider
   *
   * @param modelKey - Model key from registry (e.g., 'jina-code', 'bge-base-en-v1.5')
   * @param deviceOverride - Optional device override ('webgpu' | 'wasm' | 'cpu')
   */
  constructor(
    modelKey: string,
    private deviceOverride?: 'webgpu' | 'wasm' | 'cpu'
  ) {
    this.service = new SimpleEmbeddingService();
    this.modelKey = modelKey;
  }

  /**
   * Initialize the local model with progress tracking
   */
  async initialize(
    onProgress?: (progress: { stage: string; progress?: number }) => void
  ): Promise<void> {
    try {
      const progressAdapter = onProgress
        ? (p: EmbeddingProgress) => {
            const progressUpdate: { stage: string; progress?: number } = {
              stage: p.stage,
            };
            if (p.progress !== undefined) {
              progressUpdate.progress = p.progress;
            }
            onProgress(progressUpdate);
          }
        : undefined;

      await this.service.initializeWithModel(this.modelKey, progressAdapter, this.deviceOverride);
    } catch (error) {
      // Re-throw initialization errors - this is a setup phase
      throw new Error(
        `Failed to initialize local provider with model ${this.modelKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Generate embedding for given text
   */
  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    try {
      // Ensure service is initialized
      if (this.service.getStatus() !== 'ready') {
        // Try to initialize if not ready
        await this.initialize();
      }

      // Generate embedding using the service
      const result = await this.service.generateDocEmbedding(input.text);

      // Validate dimensions
      const validation = this.validateDimensions(result.embedding, DEFAULT_EMBEDDING_DIMENSION);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }

      // Map to new output format
      const output: EmbeddingOutput = {
        embedding: result.embedding,
        dimensions: result.dimensions,
        modelId: input.modelId,
        provider: 'local',
      };

      return { ok: true, value: output };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'model_load_failed',
          provider: 'local',
          modelId: input.modelId,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Check if provider is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // If already initialized, return true
      if (this.service.getStatus() === 'ready') {
        return true;
      }

      // Try to initialize
      await this.initialize();
      return this.service.getStatus() === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * Get model metadata from registry
   */
  getModelInfo(modelId: string): ModelConfig | null {
    return SimpleEmbeddingService.getModelConfig(modelId);
  }

  /**
   * Validate embedding dimensions match expected value
   */
  validateDimensions(
    embedding: number[],
    expectedDimensions: number
  ): Result<void, EmbeddingProviderError> {
    const actualDimensions = embedding.length;

    if (actualDimensions !== expectedDimensions) {
      return {
        ok: false,
        error: {
          type: 'dimension_mismatch',
          expected: expectedDimensions,
          received: actualDimensions,
          modelId: this.modelKey,
        },
      };
    }

    return { ok: true, value: undefined };
  }

  /**
   * Get current initialization status
   */
  getStatus(): 'idle' | 'initializing' | 'ready' | 'error' {
    const status = this.service.getStatus();

    // Map service status to provider status
    if (status === 'idle') return 'idle';
    if (status === 'initializing' || status === 'downloading') return 'initializing';
    if (status === 'ready') return 'ready';
    return 'error';
  }

  /**
   * Dispose of loaded model and free resources
   */
  async dispose(): Promise<void> {
    await this.service.dispose();
  }

  /**
   * Get the currently loaded model key
   */
  getCurrentModelKey(): string | null {
    return this.service.getCurrentModelKey();
  }

  /**
   * Get the underlying service instance (for backward compatibility)
   * @internal
   */
  getService(): SimpleEmbeddingService {
    return this.service;
  }
}
