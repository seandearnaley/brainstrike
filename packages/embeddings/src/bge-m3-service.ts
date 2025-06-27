import type {
  EmbeddingService,
  EmbeddingConfig,
  EmbeddingResult,
  SimilarityResult,
  EmbeddingStatus,
  EmbeddingProgress,
} from './types';

/**
 * A simple, reliable embedding service using transformers.js feature-extraction pipeline
 * Based on working examples from the transformers.js documentation
 */
export class SimpleEmbeddingService implements EmbeddingService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _transformers: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pipeline: any = null;
  private _status: EmbeddingStatus = 'idle';
  private _config: EmbeddingConfig = {
    modelId: 'Xenova/all-MiniLM-L6-v2', // Default model - can be overridden
    device: 'webgpu',
    quantized: true,
  };

  async initialize(
    config?: Partial<EmbeddingConfig>,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    if (this._status === 'initializing') {
      return;
    }

    // Check if we're trying to initialize with a different model
    if (this._status === 'ready' && config?.modelId && config.modelId !== this._config.modelId) {
      throw new Error('Cannot switch models without disposing first. Call dispose() before initializing with a different model.');
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._transformers = (await import('@huggingface/transformers')) as any;

      onProgress?.({
        stage: 'downloading',
        progress: 25,
        message: 'Creating feature extraction pipeline...',
      });

      console.log(`Creating feature extraction pipeline for ${this._config.modelId}...`);

      // Use feature-extraction pipeline with robust configuration
      const pipelineConfig: any = {
        quantized: this._config.quantized,
        progressCallback: (progress: any) => {
          if (progress.status === 'downloading') {
            const progressPercent = Math.round((progress.loaded / progress.total) * 100);
            onProgress?.({
              stage: 'downloading',
              progress: 25 + progressPercent * 0.5, // 25-75%
              message: `Downloading ${progress.file}... ${progressPercent}%`,
            });
          }
        },
      };

      // Add device configuration if WebGPU is requested and supported
      if (this._config.device === 'webgpu') {
        try {
          // Check if WebGPU is available
          if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
            pipelineConfig.device = 'webgpu';
          } else {
            console.log('WebGPU not available, falling back to WASM');
            pipelineConfig.device = 'wasm';
          }
        } catch (error) {
          console.log('WebGPU check failed, using WASM fallback');
          pipelineConfig.device = 'wasm';
        }
      } else {
        pipelineConfig.device = this._config.device;
      }

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
      console.log(`Feature extraction pipeline ready for ${this._config.modelId}!`);
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
  }
}
