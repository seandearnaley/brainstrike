import { calculateCosineSimilarity } from './embedding-math';
import { ModelRegistryManager } from './model-registry';
import { TransformersBackend } from './transformers-backend';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  ModelConfig,
  SimilarityResult,
} from './types';

export interface DownloadModelOptions {
  cacheDir?: string;
  onProgress?: (progress: EmbeddingProgress) => void;
}

/**
 * A registry-aware embedding service using transformers.js feature-extraction pipeline
 * Supports plug-and-play model switching via JSON manifest
 */
export class SimpleEmbeddingService implements EmbeddingService {
  private _backend: TransformersBackend;
  private _status: EmbeddingStatus = 'idle';
  private _config: EmbeddingConfig;
  private _currentModelKey: string | null = null;
  private _currentModelConfig: ModelConfig | null = null;

  constructor() {
    this._backend = new TransformersBackend();

    // Initialize with default model from registry
    const defaultModel = ModelRegistryManager.getDefaultModel();
    this._config = {
      modelId: defaultModel.id,
      device: 'webgpu',
      quantized: ModelRegistryManager.shouldQuantize(defaultModel),
    };
    this._backend.setTargetDimensions(defaultModel.dimensions);
  }

  /**
   * Initialize with a model key from the registry OR a full model configuration
   */
  async initializeWithModel(
    modelKeyOrConfig?: string | ModelConfig,
    onProgress?: (progress: EmbeddingProgress) => void,
    deviceOverride?: 'webgpu' | 'wasm' | 'cpu',
    cacheDir?: string
  ): Promise<void> {
    let modelConfig: ModelConfig | null = null;

    if (typeof modelKeyOrConfig === 'object') {
      modelConfig = modelKeyOrConfig;
    } else {
      const key = modelKeyOrConfig || ModelRegistryManager.getDefaultModelKey();
      modelConfig = ModelRegistryManager.getModel(key);
    }

    if (!modelConfig) {
      throw new Error('Model configuration not found');
    }

    const config: Partial<EmbeddingConfig> = {
      modelId: modelConfig.id,
      device: deviceOverride || this._config.device || 'webgpu',
      quantized: ModelRegistryManager.shouldQuantize(modelConfig),
      ...(cacheDir ? { cacheDir } : {}),
    };

    this._backend.setTargetDimensions(modelConfig.dimensions);

    this._currentModelKey =
      typeof modelKeyOrConfig === 'string' ? modelKeyOrConfig : modelConfig.id;
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

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
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
    return this._backend.generateEmbedding(withPrompt, this._config.modelId);
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
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
    return this._backend.generateEmbeddings(withPrompts, this._config.modelId);
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult {
    return calculateCosineSimilarity(embedding1, embedding2);
  }

  /**
   * Generate an embedding optimized for document/passages (indexing)
   */
  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }

  /**
   * Generate an embedding optimized for search queries
   */
  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }
    const withPrompt = applyRetrievalPrompt(
      text,
      'query',
      this._currentModelConfig?.id || this._config.modelId,
      this._currentModelKey
    );
    return this._backend.generateEmbedding(withPrompt, this._config.modelId);
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

  /**
   * Instance proxy: get the default model key from registry
   */
  getDefaultModelKey(): string {
    return SimpleEmbeddingService.getDefaultModelKey();
  }

  /**
   * Static method to get the default model key
   */
  static getDefaultModelKey(): string {
    return ModelRegistryManager.getDefaultModelKey();
  }

  /**
   * Instance proxy: get the model registry
   */
  getRegistry() {
    return SimpleEmbeddingService.getRegistry();
  }

  /**
   * Static method to get the model registry
   */
  static getRegistry() {
    return ModelRegistryManager.getRegistry();
  }

  async dispose(): Promise<void> {
    await this._backend.dispose();
    this._status = 'idle';
    this._currentModelKey = null;
    this._currentModelConfig = null;
  }

  /**
   * Static method to get a specific model configuration
   */
  static getModelConfig(key: string): ModelConfig | null {
    return ModelRegistryManager.getModel(key);
  }

  /**
   * Static method to list all available models from registry
   */
  static listModels(): Record<string, ModelConfig> {
    return ModelRegistryManager.listModels();
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
        if (options?.onProgress && p.status === 'downloading' && p.loaded && p.total) {
          const progressPercent = Math.round((p.loaded / p.total) * 100);
          options.onProgress({
            stage: 'downloading',
            progress: progressPercent,
            message: `Downloading ${p.file || 'model'}... ${progressPercent}%`,
          });
        }
      },
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
