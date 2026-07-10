import { SimpleEmbeddingService } from '../../bge-m3-service';
import type { EmbeddingInput, ILocalEmbeddingProvider } from '../../interfaces/provider';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  ProviderMetadata,
  Result,
} from '../../provider-types';
import type { EmbeddingProgress, ModelConfig } from '../../types';

/** Default distance metric for local transformers models */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

/** Default dimensions when only model ID is provided (for backward compatibility) */
const DEFAULT_DIMENSIONS = 768;

/**
 * Local embedding provider using transformers.js
 * Wraps the existing SimpleEmbeddingService with the new provider interface
 *
 * Implements Result pattern for error handling instead of thrown exceptions
 */
export class TransformersEmbeddingProvider implements ILocalEmbeddingProvider {
  readonly runtime = 'browser' as const;
  readonly provider = 'local' as const;

  private readonly service: SimpleEmbeddingService;
  private readonly modelConfig: ModelConfig;
  private expectedDimensions: number | null = null;

  /**
   * Create a new local embedding provider
   *
   * @param modelConfigOrId - Model configuration from database, or model ID string for backward compatibility
   * @param deviceOverride - Optional device override ('webgpu' | 'wasm')
   */
  constructor(
    modelConfigOrId: ModelConfig | string,
    private readonly deviceOverride?: 'webgpu' | 'wasm'
  ) {
    this.service = new SimpleEmbeddingService();
    // Support both ModelConfig object and legacy string modelId
    if (typeof modelConfigOrId === 'string') {
      // Create minimal config from model ID (for backward compatibility with factory tests)
      this.modelConfig = {
        description: 'Dynamically created config from model ID',
        dimensions: DEFAULT_DIMENSIONS,
        id: modelConfigOrId,
        name: modelConfigOrId,
        quantized: false,
        tags: ['local'],
      };
    } else {
      this.modelConfig = modelConfigOrId;
    }
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

      // Initialize with model config from database
      await this.service.initializeWithModel(
        this.modelConfig,
        progressAdapter,
        this.deviceOverride
      );

      // Store expected dimensions from model config for validation
      this.expectedDimensions = this.modelConfig.dimensions;
    } catch (error) {
      // Re-throw initialization errors - this is a setup phase
      throw new Error(
        `Failed to initialize local provider with model ${this.modelConfig.id}: ${error instanceof Error ? error.message : String(error)}`
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
      let embeddings: number[][];
      let dimensions: number;
      const executionOptions = input.signal ? { signal: input.signal } : undefined;

      if (Array.isArray(input.text)) {
        const results = await this.service.generateEmbeddings(input.text, executionOptions);
        embeddings = results.map((r) => r.embedding);
        dimensions = results[0]?.dimensions || 0;
      } else {
        const result = await this.service.generateDocEmbedding(input.text, executionOptions);
        embeddings = [result.embedding];
        dimensions = result.dimensions;
      }

      if (embeddings.length === 0) {
        throw new Error('No embeddings generated');
      }

      // Validate dimensions against model's expected dimensions
      if (this.expectedDimensions !== null) {
        for (const emb of embeddings) {
          const validation = this.validateDimensions(emb, this.expectedDimensions);
          if (!validation.ok) {
            return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
          }
        }
      }

      // Map to new output format
      const output: EmbeddingOutput = {
        dimensions,
        embedding: embeddings[0] ?? [],
        embeddings,
        modelId: input.modelId,
        provider: 'local',
      };

      return { ok: true, value: output };
    } catch (error) {
      return {
        error: {
          modelId: input.modelId,
          provider: 'local',
          reason: error instanceof Error ? error.message : String(error),
          type: 'model_load_failed',
        },
        ok: false,
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
   * Get model configuration by ID
   * Returns the model config if it matches the loaded model, null otherwise
   */
  getModelInfo(modelId: string): ModelConfig | null {
    return modelId === this.modelConfig.id ? this.modelConfig : null;
  }

  /**
   * Get unified provider metadata for embedding-set creation and validation (BST-167)
   * Returns metadata about the current provider including dimensions and distance metric
   */
  getMetadata(modelId: string): ProviderMetadata | null {
    if (modelId !== this.modelConfig.id) {
      return null;
    }
    return {
      dimensions: this.modelConfig.dimensions,
      displayName: this.modelConfig.name,
      distance: DEFAULT_DISTANCE_METRIC,
      modelKey: this.modelConfig.id,
      providerId: 'local',
      ...(this.modelConfig.contextWindow !== undefined && {
        contextWindow: this.modelConfig.contextWindow,
      }),
    };
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
        error: {
          expected: expectedDimensions,
          modelId: this.modelConfig.id,
          received: actualDimensions,
          type: 'dimension_mismatch',
        },
        ok: false,
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
    if (status === 'idle') {
      return 'idle';
    }
    if (status === 'initializing' || status === 'downloading') {
      return 'initializing';
    }
    if (status === 'ready') {
      return 'ready';
    }
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
   * Get the model configuration
   */
  getModelConfig(): ModelConfig {
    return this.modelConfig;
  }

  /**
   * Get the underlying service instance (for backward compatibility)
   * @internal
   */
  getService(): SimpleEmbeddingService {
    return this.service;
  }
}
