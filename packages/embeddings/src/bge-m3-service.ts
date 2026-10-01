import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { calculateCosineSimilarity } from './embedding-math.js';
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
  signal?: AbortSignal;
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

    // Determine if quantization should be used (768D or smaller models benefit from quantization)
    const shouldQuantize = modelConfig.dimensions <= 768 && !modelConfig.quantized;

    const config: Partial<EmbeddingConfig> = {
      device: deviceOverride || this._config.device || 'webgpu',
      modelId: modelConfig.id,
      quantized: shouldQuantize,
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
      this._config = { ...this._config, ...config };
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
    // Default path treats input as a document/passsage for retrieval
    const withPrompt = applyRetrievalPrompt(
      text,
      'document',
      this._currentModelConfig?.id || this._config.modelId,
      this._currentModelKey
    );
    return this._backend.generateEmbedding(withPrompt, this._config.modelId, options);
  }

  async generateEmbeddings(
    texts: string[],
    options?: EmbeddingExecutionOptions
  ): Promise<EmbeddingResult[]> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    const withPrompts = texts.map((text) =>
      applyRetrievalPrompt(
        text,
        'document',
        this._currentModelConfig?.id || this._config.modelId,
        this._currentModelKey
      )
    );
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
    const withPrompts = texts.map((text) =>
      applyRetrievalPrompt(
        text,
        'document',
        this._currentModelConfig?.id || this._config.modelId,
        this._currentModelKey
      )
    );
    return await this._backend.generateEmbeddingsStream(
      withPrompts,
      this._config.modelId,
      onBatch,
      options
    );
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
    const withPrompt = applyRetrievalPrompt(
      text,
      'query',
      this._currentModelConfig?.id || this._config.modelId,
      this._currentModelKey
    );
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
    return this._backend.downloadModel(modelId, {
      ...(options?.cacheDir ? { cacheDir: options.cacheDir } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(this._config.streamingWorkerUrl
        ? { streamingWorkerUrl: this._config.streamingWorkerUrl }
        : {}),
      onProgress: ({ progress }) => options?.onProgress?.({ progress, stage: 'downloading' }),
    });
  }
}

// Lightweight, model-aware prompting to improve retrieval alignment
function applyRetrievalPrompt(
  text: string,
  role: 'query' | 'document',
  modelId: string,
  modelKey: string | null
): string {
  const id = (modelId || '').toLowerCase();
  const key = (modelKey || '').toLowerCase();

  // BGE-M3 specifically does NOT need prefixes per official BAAI docs
  // https://huggingface.co/BAAI/bge-m3/discussions/35
  // "bge-m3 doesn't need prefix instruction"
  const isBgeM3 = id.includes('bge-m3') || key.includes('bge-m3');
  if (isBgeM3) {
    return text; // No prefix for M3
  }

  // Other BGE models (bge-base, bge-large, bge-small, etc.) DO need prefixes
  const isBge = id.includes('bge-') || key.includes('bge-');
  if (isBge) {
    return (role === 'query' ? 'query: ' : 'passage: ') + text;
  }

  // Jina code/base: lightly steer towards code retrieval
  const isJina = id.includes('jina-embeddings') || key.includes('jina');
  if (isJina) {
    if (role === 'query') {
      return `Represent the programming question for retrieving relevant code snippets:\n${text}`;
    }
    return `Represent the following code snippet for retrieval:\n${text}`;
  }

  // Sentence transformers and general models: generic retrieval steering
  if (role === 'query') {
    return `Search query for semantic retrieval:\n${text}`;
  }
  return `Document passage for semantic retrieval:\n${text}`;
}
