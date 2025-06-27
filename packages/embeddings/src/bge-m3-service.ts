import { ModelRegistryManager } from './model-registry';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  ModelConfig,
  SimilarityResult,
} from './types';

// Type definitions for transformers.js
interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    config: PipelineConfig
  ) => Promise<FeatureExtractionPipeline>;
}

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean }
) => Promise<{
  data: Float32Array;
}>;

interface PipelineConfig {
  quantized?: boolean;
  device?: string;
  progressCallback?: (progress: ProgressInfo) => void;
}

interface ProgressInfo {
  status: string;
  loaded?: number;
  total?: number;
  file?: string;
}

/**
 * Determine the appropriate device for the current environment
 */
function determineDevice(requestedDevice: string | undefined): string {
  if (requestedDevice === 'webgpu') {
    try {
      // Check if we're in a browser environment with WebGPU support
      if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        return 'webgpu';
      }
    } catch (_error) {
      // Fallback to CPU if WebGPU check fails
    }
    return 'cpu';
  }

  if (requestedDevice === 'wasm') {
    // In Node.js, WASM isn't supported, use CPU instead
    if (typeof window === 'undefined') {
      return 'cpu';
    }
    return 'wasm';
  }

  return requestedDevice || 'cpu';
}

/**
 * A registry-aware embedding service using transformers.js feature-extraction pipeline
 * Supports plug-and-play model switching via JSON manifest
 */
export class SimpleEmbeddingService implements EmbeddingService {
  private _transformers: TransformersModule | null = null;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private _status: EmbeddingStatus = 'idle';
  private _config: EmbeddingConfig;
  private _currentModelKey: string | null = null;
  private _currentModelConfig: ModelConfig | null = null;

  constructor() {
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
      onProgress?.({
        stage: 'downloading',
        progress: 0,
        message: 'Loading transformers.js...',
      });

      // Dynamic import to avoid bundling issues
      this._transformers = (await import('@huggingface/transformers')) as TransformersModule;

      onProgress?.({
        stage: 'downloading',
        progress: 25,
        message: 'Creating feature extraction pipeline...',
      });

      // Use feature-extraction pipeline with robust configuration
      const pipelineConfig: PipelineConfig = {
        ...(this._config.quantized !== undefined && { quantized: this._config.quantized }),
        progressCallback: (progress: ProgressInfo) => {
          if (progress.status === 'downloading' && progress.loaded && progress.total) {
            const progressPercent = Math.round((progress.loaded / progress.total) * 100);
            onProgress?.({
              stage: 'downloading',
              progress: 25 + progressPercent * 0.5, // 25-75%
              message: `Downloading ${progress.file || 'model'}... ${progressPercent}%`,
            });
          }
        },
      };

      // Add device configuration based on environment
      pipelineConfig.device = determineDevice(this._config.device);

      this._pipeline = await this._transformers.pipeline(
        'feature-extraction',
        this._config.modelId,
        pipelineConfig
      );

      onProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'Model ready!',
      });

      this._status = 'ready';
    } catch (error) {
      console.error('Failed to initialize embedding service:', error);
      this._status = 'error';
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (this._status !== 'ready' || !this._pipeline) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    try {
      // Use the feature extraction pipeline with proper options
      const output = await this._pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert the output to a regular array
      const embedding = Array.from(output.data as Float32Array);

      return {
        embedding,
        dimensions: embedding.length,
        model: this._config.modelId,
      };
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      throw error;
    }
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimensions');
    }

    // Calculate cosine similarity
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      const val1 = embedding1[i];
      const val2 = embedding2[i];
      if (val1 !== undefined && val2 !== undefined) {
        dotProduct += val1 * val2;
        norm1 += val1 * val1;
        norm2 += val2 * val2;
      }
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

    return {
      similarity,
      distance: 1 - similarity, // Convert to distance
      method: 'cosine',
    };
  }

  getStatus(): EmbeddingStatus {
    return this._status;
  }

  getConfig(): EmbeddingConfig {
    return { ...this._config };
  }

  async dispose(): Promise<void> {
    this._pipeline = null;
    this._transformers = null;
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
