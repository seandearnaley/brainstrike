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
  }

  /**
   * Initialize with a model key from the registry
   */
  async initializeWithModel(
    modelKey?: string,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    const key = modelKey || ModelRegistryManager.getDefaultModelKey();
    const modelConfig = ModelRegistryManager.getModel(key);

    if (!modelConfig) {
      throw new Error(`Model '${key}' not found in registry`);
    }

    const config: Partial<EmbeddingConfig> = {
      modelId: modelConfig.id,
      device: this._config.device || 'webgpu',
      quantized: ModelRegistryManager.shouldQuantize(modelConfig),
    };

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

    try {
      await this._backend.initialize(this._config, onProgress);
      this._status = 'ready';
    } catch (error) {
      console.error('Failed to initialize embedding service:', error);
      this._status = 'error';
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (this._status !== 'ready' || !this._backend.isInitialized()) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    return this._backend.generateEmbedding(text, this._config.modelId);
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult {
    return calculateCosineSimilarity(embedding1, embedding2);
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

  async dispose(): Promise<void> {
    await this._backend.dispose();
    this._status = 'idle';
    this._currentModelKey = null;
    this._currentModelConfig = null;
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
   * Static method to list all available models from registry
   */
  static listModels(): Record<string, ModelConfig> {
    return ModelRegistryManager.listModels();
  }

  /**
   * Static method to get the default model key
   */
  static getDefaultModelKey(): string {
    return ModelRegistryManager.getDefaultModelKey();
  }

  /**
   * Static method to get a specific model configuration
   */
  static getModelConfig(key: string): ModelConfig | null {
    return ModelRegistryManager.getModel(key);
  }

  /**
   * Static method to get the model registry
   */
  static getRegistry() {
    return ModelRegistryManager.getRegistry();
  }
}
