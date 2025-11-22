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
   * Initialize with a model key from the registry
   */
  async initializeWithModel(
    modelKey?: string,
    onProgress?: (progress: EmbeddingProgress) => void,
    deviceOverride?: 'webgpu' | 'wasm' | 'cpu'
  ): Promise<void> {
    const key = modelKey || ModelRegistryManager.getDefaultModelKey();
    const modelConfig = ModelRegistryManager.getModel(key);

    if (!modelConfig) {
      throw new Error(`Model '${key}' not found in registry`);
    }

    const config: Partial<EmbeddingConfig> = {
      modelId: modelConfig.id,
      device: deviceOverride || this._config.device || 'webgpu',
      quantized: ModelRegistryManager.shouldQuantize(modelConfig),
    };

    this._backend.setTargetDimensions(modelConfig.dimensions);

    this._currentModelKey = key;
    this._currentModelConfig = modelConfig;

    return this.initialize(config, onProgress);
  }

  async initialize(
    config?: Partial<EmbeddingConfig>,
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

    const maybeModelConfig = (config as { modelConfig?: ModelConfig | undefined })?.modelConfig;
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

  // BGE family: use query/passsage prefixes per model guidance
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
