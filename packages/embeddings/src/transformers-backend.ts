import type { EmbeddingConfig, EmbeddingProgress, EmbeddingResult, ModelConfig } from './types';

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

// Cache the imported module to avoid duplicate imports across instances
let transformersModule: TransformersModule | null = null;
let transformersModulePromise: Promise<TransformersModule> | null = null;

async function getTransformersModule(): Promise<TransformersModule> {
  if (transformersModule) {
    return transformersModule;
  }
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers') as Promise<TransformersModule>;
  }
  transformersModule = await transformersModulePromise;
  return transformersModule;
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
 * Backend implementation using Hugging Face Transformers.js
 * Handles model loading, device selection, and inference
 */
export class TransformersBackend {
  private _transformers: TransformersModule | null = null;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private _selectedDevice: string | null = null;
  private _isInitialized = false;
  private _quantized: boolean | undefined;

  /**
   * Initialize the backend with a model configuration
   */
  async initialize(
    config: EmbeddingConfig & { modelConfig?: ModelConfig },
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    onProgress?.({
      stage: 'downloading',
      progress: 0,
      message: 'Loading transformers.js...',
    });

    // Dynamic import to avoid bundling issues (cached across instances)
    this._transformers = await getTransformersModule();

    onProgress?.({
      stage: 'downloading',
      progress: 25,
      message: 'Creating feature extraction pipeline...',
    });

    // Use feature-extraction pipeline with robust configuration
    const pipelineConfig: PipelineConfig = {
      ...(config.quantized !== undefined && { quantized: config.quantized }),
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
    this._selectedDevice = determineDevice(config.device);
    this._quantized = config.quantized;
    pipelineConfig.device = this._selectedDevice;

    // Try requested device, then gracefully fall back to CPU if creation fails
    try {
      this._pipeline = await this._transformers.pipeline(
        'feature-extraction',
        config.modelId,
        pipelineConfig
      );
    } catch (err) {
      // Fallback only if not already on CPU
      if (this._selectedDevice !== 'cpu') {
        this._selectedDevice = 'cpu';
        onProgress?.({ stage: 'downloading', progress: 85, message: 'Falling back to CPU…' });
        this._pipeline = await this._transformers.pipeline('feature-extraction', config.modelId, {
          ...pipelineConfig,
          device: 'cpu',
        });
      } else {
        throw err;
      }
    }

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model ready!',
    });

    this._isInitialized = true;
  }

  /**
   * Generate embedding for a given text
   */
  async generateEmbedding(text: string, modelId: string): Promise<EmbeddingResult> {
    if (!this._isInitialized || !this._pipeline) {
      throw new Error('Backend not initialized. Call initialize() first.');
    }
    // Use the feature extraction pipeline with proper options
    let output: { data: Float32Array };
    try {
      output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    } catch (err) {
      // Runtime fallback: if not already on CPU, recreate pipeline on CPU and retry once
      if (this._transformers && this._selectedDevice !== 'cpu') {
        this._selectedDevice = 'cpu';
        const cfg: PipelineConfig = { device: 'cpu' };
        if (typeof this._quantized === 'boolean') cfg.quantized = this._quantized;
        this._pipeline = await this._transformers.pipeline('feature-extraction', modelId, cfg);
        output = await this._pipeline(text, { pooling: 'mean', normalize: true });
      } else {
        throw err;
      }
    }

    // Convert the output to a regular array
    const embedding = Array.from(output.data as Float32Array);

    return {
      embedding,
      dimensions: embedding.length,
      model: modelId,
    };
  }

  /**
   * Get the selected device for inference
   */
  getSelectedDevice(): string | null {
    return this._selectedDevice;
  }

  /**
   * Check if the backend is initialized
   */
  isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Dispose of the backend and clean up resources
   */
  async dispose(): Promise<void> {
    // Properly dispose of the pipeline if it has a dispose method
    if (
      this._pipeline &&
      'dispose' in this._pipeline &&
      typeof this._pipeline.dispose === 'function'
    ) {
      try {
        await (this._pipeline as unknown as { dispose: () => Promise<void> }).dispose();
      } catch (_error) {}
    }

    this._pipeline = null;
    this._transformers = null;
    this._selectedDevice = null;
    this._isInitialized = false;
  }

  /**
   * Static method to determine the best device for the current environment
   */
  static getBestDevice(): string {
    return determineDevice('webgpu');
  }

  /**
   * Static method to check if a specific device is available
   */
  static isDeviceAvailable(device: string): boolean {
    switch (device) {
      case 'webgpu':
        try {
          return typeof navigator !== 'undefined' && 'gpu' in navigator;
        } catch {
          return false;
        }
      case 'wasm':
        return typeof window !== 'undefined';
      case 'cpu':
        return true;
      default:
        return false;
    }
  }
}
