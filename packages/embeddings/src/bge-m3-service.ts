import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { calculateCosineSimilarity } from './embedding-math.js';
import { quantizesUnpinnedLoad } from './inference-plan.js';
import { TransformersBackend } from './transformers-backend.js';
import type {
  EmbeddingConfig,
  EmbeddingExecutionOptions,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  EmbeddingStreamBatch,
  EmbeddingStreamOptions,
  ModelConfig,
  SimilarityResult,
} from './types.js';

export interface DownloadModelOptions {
  cacheDir?: string;
  onProgress?: (progress: EmbeddingProgress) => void;
}

export interface SimpleEmbeddingServiceOptions {
  readonly streamBatchSize?: number;
  readonly streamingWorkerUrl?: string;
}

/**
 * Embedding service using transformers.js feature-extraction pipeline.
 * Model configuration must be provided via initializeWithModel() from database.
 */
export class SimpleEmbeddingService implements EmbeddingService {
  private readonly _backend: TransformersBackend;
  private _status: EmbeddingStatus = 'idle';
  private _config: EmbeddingConfig;
  private _currentModelKey: string | null = null;
  private _currentModelConfig: ModelConfig | null = null;

  constructor(options: SimpleEmbeddingServiceOptions = {}) {
    this._backend = new TransformersBackend();

    // Default config - will be overwritten by initializeWithModel()
    // WebGPU is the default device for optimal throughput. The embedding worker
    // has a keep-alive guard that prevents GPU idle crashes in Electron.
    // See: docs/debug-handoff-renderer-crash.md
    this._config = {
      device: 'webgpu',
      modelId: 'jinaai/jina-embeddings-v2-base-code', // Default HuggingFace ID
      quantized: false,
      ...(options.streamBatchSize ? { streamBatchSize: options.streamBatchSize } : {}),
      ...(options.streamingWorkerUrl ? { streamingWorkerUrl: options.streamingWorkerUrl } : {}),
    };
    this._backend.setTargetDimensions(DEFAULT_EMBEDDING_DIMENSION);
  }

  /**
   * Initialize with a model configuration from the database or model ID string.
   * @param modelConfigOrId - ModelConfig object from database, or model ID string for backward compatibility
   */
  async initializeWithModel(
    modelConfigOrId: ModelConfig | string,
    onProgress?: (progress: EmbeddingProgress) => void,
    deviceOverride?: 'webgpu' | 'wasm',
    cacheDir?: string
  ): Promise<void> {
    if (!modelConfigOrId) {
      throw new Error('ModelConfig or model ID is required');
    }

    // Support both ModelConfig object and legacy string modelId
    const modelConfig: ModelConfig =
      typeof modelConfigOrId === 'string'
        ? {
            description: 'Dynamically created config from model ID',
            dimensions: DEFAULT_EMBEDDING_DIMENSION,
            id: modelConfigOrId,
            name: modelConfigOrId,
            quantized: false,
            tags: ['local'],
          }
        : modelConfigOrId;

    const shouldQuantize = quantizesUnpinnedLoad(modelConfig);

    const config: Partial<EmbeddingConfig> = {
      device: deviceOverride || this._config.device || 'webgpu',
      modelId: modelConfig.id,
      quantized: shouldQuantize,
      ...(modelConfig.pooling === undefined ? {} : { pooling: modelConfig.pooling }),
      ...(modelConfig.prompts === undefined ? {} : { prompts: modelConfig.prompts }),
      ...(cacheDir ? { cacheDir } : {}),
    };

    this._backend.setTargetDimensions(modelConfig.dimensions);

    this._currentModelKey = modelConfig.id;
    this._currentModelConfig = modelConfig;

    return this.initialize({ ...config, modelConfig }, onProgress);
  }

  async initialize(
    config?: Partial<EmbeddingConfig> & { modelConfig?: ModelConfig },
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    if (this._status === 'initializing') {
      return;
    }

    // Check if we're trying to initialize with a different model
    if (this._status === 'ready' && config?.modelId && config.modelId !== this._config.modelId) {
      throw new Error(
        'Cannot switch models without disposing first. Call dispose() before initializing with a different model.'
      );
    }

    if (this._status === 'ready') {
      return; // Already initialized with same model
    }

    this._status = 'initializing';

    if (config) {
      // Pooling and prompts belong to the model being loaded: never inherit a previous one's.
      const { pooling: _pooling, prompts: _prompts, ...kept } = this._config;
      this._config = { ...kept, ...config };
    }

    const maybeModelConfig = config?.modelConfig;
    if (maybeModelConfig?.dimensions) {
      this._backend.setTargetDimensions(maybeModelConfig.dimensions);
    } else if (this._currentModelConfig) {
      this._backend.setTargetDimensions(this._currentModelConfig.dimensions);
    }

    try {
      await this._backend.initialize(this._config, onProgress);
      this._status = 'ready';
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async generateEmbedding(
    text: string,
    options?: EmbeddingExecutionOptions
  ): Promise<EmbeddingResult> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    // Default path treats input as a document/passage for retrieval
    const withPrompt = this.prompted(text, 'document');
    return this._backend.generateEmbedding(withPrompt, this._config.modelId, options);
  }

  async generateEmbeddings(
    texts: string[],
    options?: EmbeddingExecutionOptions
  ): Promise<EmbeddingResult[]> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    const withPrompts = texts.map((text) => this.prompted(text, 'document'));
    return this._backend.generateEmbeddings(withPrompts, this._config.modelId, options);
  }

  async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void,
    options?: EmbeddingStreamOptions
  ): Promise<unknown> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    const withPrompts = texts.map((text) => this.prompted(text, 'document'));
    return await this._backend.generateEmbeddingsStream(
      withPrompts,
      this._config.modelId,
      onBatch,
      options
    );
  }

  /**
   * The model's own prompt for this role, exactly as its catalog row states it
   * (BST-1993). No prompt stated means the raw text; nothing is guessed from
   * the model's name.
   */
  private prompted(text: string, role: 'query' | 'document'): string {
    const prompt = this._config.prompts?.[role] ?? '';
    return `${prompt}${text}`;
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult {
    return calculateCosineSimilarity(embedding1, embedding2);
  }

  /**
   * Generate an embedding optimized for document/passages (indexing)
   */
  async generateDocEmbedding(
    text: string,
    options?: EmbeddingExecutionOptions
  ): Promise<EmbeddingResult> {
    return this.generateEmbedding(text, options);
  }

  /**
   * Generate an embedding optimized for search queries
   */
  async generateQueryEmbedding(
    text: string,
    options?: EmbeddingExecutionOptions
  ): Promise<EmbeddingResult> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    const withPrompt = this.prompted(text, 'query');
    return this._backend.generateEmbedding(withPrompt, this._config.modelId, options);
  }

  getStatus(): EmbeddingStatus {
    return this._status;
  }

  getConfig(): EmbeddingConfig & { selectedDevice?: string } {
    const selectedDevice = this._backend.getSelectedDevice();
    return {
      ...this._config,
      ...(selectedDevice && { selectedDevice }),
    };
  }

  /**
   * Get the currently loaded model key
   */
  getCurrentModelKey(): string | null {
    return this._currentModelKey;
  }

  /**
   * Get the currently loaded model configuration
   */
  getCurrentModelConfig(): ModelConfig | null {
    return this._currentModelConfig;
  }

  async dispose(): Promise<void> {
    await this._backend.dispose();
    this._status = 'idle';
    this._currentModelKey = null;
    this._currentModelConfig = null;
  }

  /**
   * Download a model to the cache directory
   */
  /**
   * Download a model to the cache directory
   */
  async downloadModel(
    modelId: string,
    options?: DownloadModelOptions & { modelConfig?: ModelConfig }
  ): Promise<void> {
    // If modelConfig is provided, we can use it to set up any necessary state
    // For now, TransformersBackend.downloadModel just needs the ID, but this
    // future-proofs the API and matches the initialize pattern
    return this._backend.downloadModel(modelId, {
      ...(options?.cacheDir ? { cacheDir: options.cacheDir } : {}),
      onProgress: (p) => {
        // transformers.js uses 'progress' status (not 'downloading') for progress updates
        if (options?.onProgress && p.status === 'progress' && p.loaded && p.total) {
          const progressPercent = Math.round((p.loaded / p.total) * 100);
          options.onProgress({
            message: `Downloading ${p.file || 'model'}... ${progressPercent}%`,
            progress: progressPercent,
            stage: 'downloading',
          });
        }
      },
    });
  }
}
