import type { EmbeddingConfig, EmbeddingProgress, EmbeddingResult, ModelConfig } from './types';
import { BGE_M3_CONFIG, FALLBACK_MODEL_CONFIG } from './types';

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
  options: { pooling: string; normalize: boolean; truncate?: boolean; maxLength?: number }
) => Promise<{
  data: Float32Array;
}>;

interface PipelineConfig {
  quantized?: boolean;
  device?: string;
  dtype?: string;
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

  // requested 'cpu' → in browser, prefer 'wasm' (onnxruntime-web doesn't accept 'cpu')
  if (requestedDevice === 'cpu') {
    return typeof window === 'undefined' ? 'cpu' : 'wasm';
  }

  return requestedDevice || (typeof window === 'undefined' ? 'cpu' : 'wasm');
}

/**
 * Backend implementation using Hugging Face Transformers.js
 * Handles model loading, device selection, and inference
 */
export class TransformersBackend {
  // Runtime diagnostics (static, process-wide)
  private static _verboseOrtLogs = false;
  private static _epFallbackSeen = 0;
  private static _inferenceCount = 0;

  static setVerboseOrtLogs(enabled: boolean) {
    TransformersBackend._verboseOrtLogs = enabled;
  }

  static getRuntimeStats() {
    return {
      epFallbackSeen: TransformersBackend._epFallbackSeen,
      inferenceCount: TransformersBackend._inferenceCount,
    };
  }
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

    // Optional: enable verbose ORT logs and capture fallback hints
    try {
      // onnxruntime-web exposes a global 'ort'
      const g = globalThis as unknown as { ort?: { env?: { logLevel?: string } } };
      if (TransformersBackend._verboseOrtLogs && g.ort?.env) {
        g.ort.env.logLevel = 'verbose';
        // Monkey-patch console.warn once to catch EP assignment messages
        const kAny = globalThis as unknown as { __bsWarnPatched?: boolean } & Console;
        if (!kAny.__bsWarnPatched) {
          const origWarn = console.warn.bind(console);
          console.warn = (...args: unknown[]) => {
            const first = String(args[0] ?? '');
            if (first.includes('VerifyEachNodeIsAssignedToAnEp')) {
              TransformersBackend._epFallbackSeen += 1;
            }
            origWarn(...args);
          };
          kAny.__bsWarnPatched = true;
        }
      }
    } catch {
      // ignore if ORT not present yet
    }

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
    // Explicit dtype to avoid default warnings and ensure deterministic precision
    pipelineConfig.dtype = this._quantized ? 'q8' : 'fp32';

    // Try requested device, then gracefully fall back to CPU if creation fails
    try {
      this._pipeline = await this._transformers.pipeline(
        'feature-extraction',
        config.modelId,
        pipelineConfig
      );
    } catch (err) {
      // Fallback only if not already on CPU/WASM in browsers
      const fallbackDevice = determineDevice('cpu');
      if (this._selectedDevice !== fallbackDevice) {
        this._selectedDevice = fallbackDevice;
        onProgress?.({ stage: 'downloading', progress: 85, message: 'Falling back to CPU/WASM…' });
        this._pipeline = await this._transformers.pipeline('feature-extraction', config.modelId, {
          ...pipelineConfig,
          device: fallbackDevice,
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
    const maxLen = getMaxLengthFromModelId(modelId);
    try {
      output = await this._pipeline(text, {
        pooling: 'mean',
        normalize: true,
        truncate: true,
        maxLength: maxLen,
      });
    } catch (err) {
      // Runtime fallback: if not already on CPU/WASM, recreate pipeline and retry once
      const fallbackDevice = determineDevice('cpu');
      if (this._transformers && this._selectedDevice !== fallbackDevice) {
        this._selectedDevice = fallbackDevice;
        const cfg: PipelineConfig = { device: fallbackDevice };
        if (typeof this._quantized === 'boolean') cfg.quantized = this._quantized;
        this._pipeline = await this._transformers.pipeline('feature-extraction', modelId, cfg);
        output = await this._pipeline(text, {
          pooling: 'mean',
          normalize: true,
          truncate: true,
          maxLength: maxLen,
        });
      } else {
        throw err;
      }
    }

    // Convert the output to a regular array
    const embedding = Array.from(output.data as Float32Array);
    TransformersBackend._inferenceCount += 1;

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

function getMaxLengthFromModelId(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes('bge-m3')) return BGE_M3_CONFIG.maxLength;
  if (id.includes('minilm')) return FALLBACK_MODEL_CONFIG.maxLength;
  if (id.includes('jina')) return 8192; // Jina v2/v3 typically support long contexts for code
  // Sensible default for many sentence transformers on Web
  return 512;
}
