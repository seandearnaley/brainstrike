import type { EmbeddingDType } from '@brainstrike/embedding-worker';
import type { QueueAdapter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
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
let browserQueuePromise: Promise<QueueAdapter> | null = null;
let customQueueFactory: null | (() => QueueAdapter | Promise<QueueAdapter>) = null;

export function registerEmbeddingQueueFactory(
  factory: () => QueueAdapter | Promise<QueueAdapter>
): void {
  customQueueFactory = factory;
  browserQueuePromise = null;
}

export function resetEmbeddingQueueFactory(): void {
  customQueueFactory = null;
  browserQueuePromise = null;
}

function supportsWorkerQueue(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

async function getBrowserQueue(): Promise<QueueAdapter> {
  if (customQueueFactory) {
    return Promise.resolve(customQueueFactory());
  }
  if (!browserQueuePromise) {
    browserQueuePromise = import('@brainstrike/queue').then(({ createBrowserEmbeddingQueue }) =>
      createBrowserEmbeddingQueue()
    );
  }
  return browserQueuePromise;
}

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
function determineDevice(requestedDevice: string | undefined): 'webgpu' | 'wasm' | 'cpu' {
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

  const fallback = typeof window === 'undefined' ? 'cpu' : 'wasm';
  if (requestedDevice === 'webgpu' || requestedDevice === 'wasm' || requestedDevice === 'cpu') {
    return requestedDevice;
  }
  return fallback;
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
  private _selectedDevice: 'webgpu' | 'wasm' | 'cpu' | null = null;
  private _isInitialized = false;
  private _quantized: boolean | undefined;
  private _useWorkerQueue = false;
  private _queue: QueueAdapter | null = null;
  private _targetDimensions: number | null = null;
  private _config: (EmbeddingConfig & { modelConfig?: ModelConfig }) | null = null;
  private _selectedDType: EmbeddingDType | null = null;

  private resolveDTypeForDevice(
    device: 'webgpu' | 'wasm' | 'cpu',
    quantized?: boolean
  ): EmbeddingDType {
    if (device === 'webgpu') {
      return 'fp16';
    }
    if (device === 'wasm') {
      return quantized ? 'q4' : 'fp32';
    }
    return 'fp32';
  }

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

    this._config = { ...config };

    this._selectedDevice = determineDevice(config.device);
    this._quantized = config.quantized;
    this._selectedDType = this.resolveDTypeForDevice(this._selectedDevice, this._quantized);

    if (supportsWorkerQueue()) {
      try {
        onProgress?.({
          stage: 'processing',
          progress: 10,
          message: 'Preparing embedding worker queue...',
        });
        this._queue = await getBrowserQueue();
        this._useWorkerQueue = true;
        await this.warmupQueue(config);
        this._isInitialized = true;
        onProgress?.({
          stage: 'ready',
          progress: 100,
          message: 'Model ready!',
        });
        return;
      } catch (_error) {
        this._useWorkerQueue = false;
        this._queue = null;
        // Fall through to local pipeline initialization
      }
    }

    await this.createPipeline(config, onProgress);
  }

  private async createPipeline(
    config: EmbeddingConfig & { modelConfig?: ModelConfig },
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
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
    const resolvedDevice = (this._selectedDevice ?? determineDevice(config.device)) as
      | 'webgpu'
      | 'wasm'
      | 'cpu';
    this._selectedDevice = resolvedDevice;
    pipelineConfig.device = resolvedDevice;
    const dtype = this.resolveDTypeForDevice(resolvedDevice, this._quantized);
    this._selectedDType = dtype;
    pipelineConfig.dtype = dtype;

    const instantiatePipeline = async () => {
      if (!this._transformers) {
        throw new Error('Transformers module not initialized');
      }
      this._pipeline = await this._transformers.pipeline(
        'feature-extraction',
        config.modelId,
        pipelineConfig
      );
    };

    const fallbackToCpu = async (lastError: unknown) => {
      const fallbackDevice = determineDevice('cpu');
      if (this._selectedDevice === fallbackDevice) {
        throw lastError;
      }
      this._selectedDevice = fallbackDevice;
      onProgress?.({ stage: 'downloading', progress: 85, message: 'Falling back to CPU/WASM…' });
      pipelineConfig.device = fallbackDevice;
      const fallbackDType = this.resolveDTypeForDevice(fallbackDevice, this._quantized);
      pipelineConfig.dtype = fallbackDType;
      this._selectedDType = fallbackDType;
      await instantiatePipeline();
    };

    try {
      await instantiatePipeline();
    } catch (initialError) {
      if (pipelineConfig.quantized) {
        console.warn(
          '[TransformersBackend] Quantized pipeline failed, retrying without quantization',
          initialError
        );
        pipelineConfig.quantized = false;
        this._quantized = false;
        const retryDType = this.resolveDTypeForDevice(
          (pipelineConfig.device as 'webgpu' | 'wasm' | 'cpu' | undefined) ?? resolvedDevice,
          false
        );
        pipelineConfig.dtype = retryDType;
        this._selectedDType = retryDType;
        try {
          await instantiatePipeline();
        } catch (retryError) {
          await fallbackToCpu(retryError);
        }
      } else {
        await fallbackToCpu(initialError);
      }
    }

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model ready!',
    });

    this._isInitialized = true;
  }

  private async warmupQueue(
    config: EmbeddingConfig & { modelConfig?: ModelConfig }
  ): Promise<void> {
    const queue = this._queue;
    if (!queue) {
      return;
    }
    const warmupId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `warmup-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    try {
      const targetDimension = this._targetDimensions ?? DEFAULT_EMBEDDING_DIMENSION;
      await queue.add({
        kind: 'embed',
        id: warmupId,
        model: config.modelId,
        texts: ['.'],
        ...(this._targetDimensions ? { truncateDim: this._targetDimensions } : {}),
        targetDimension,
        deviceHint:
          this._selectedDevice === 'webgpu'
            ? 'webgpu'
            : this._selectedDevice === 'wasm'
              ? 'wasm'
              : 'auto',
        dtype: this._selectedDType ?? 'fp16',
        maxBatchSize: 1,
      });
    } catch {
      // Warm-up is best effort; ignore failures
    }
  }

  private async ensureLocalPipeline(modelId: string): Promise<FeatureExtractionPipeline> {
    if (!this._pipeline) {
      const fallbackConfig = {
        ...(this._config ?? {}),
        modelId,
      } as EmbeddingConfig & { modelConfig?: ModelConfig };
      if (!fallbackConfig.device && this._selectedDevice) {
        fallbackConfig.device = this._selectedDevice;
      }
      if (fallbackConfig.quantized === undefined && typeof this._quantized === 'boolean') {
        fallbackConfig.quantized = this._quantized;
      }
      await this.createPipeline(fallbackConfig, undefined);
    }
    if (!this._pipeline) {
      throw new Error('Failed to initialize embedding pipeline');
    }
    return this._pipeline;
  }

  /**
   * Generate embedding for a given text
   */
  async generateEmbedding(text: string, modelId: string): Promise<EmbeddingResult> {
    if (!this._isInitialized) {
      throw new Error('Backend not initialized. Call initialize() first.');
    }

    const maybeQueueResult = await this.tryGenerateWithQueue(text, modelId);
    if (maybeQueueResult) {
      return maybeQueueResult;
    }

    const pipeline = await this.ensureLocalPipeline(modelId);
    // Use the feature extraction pipeline with proper options
    let output: { data: Float32Array };
    const maxLen = getMaxLengthFromModelId(modelId);
    try {
      output = await pipeline(text, {
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
        const dtype = this.resolveDTypeForDevice(fallbackDevice, this._quantized);
        this._selectedDType = dtype;
        const cfg: PipelineConfig = { device: fallbackDevice, dtype };
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

  private async tryGenerateWithQueue(
    text: string,
    modelId: string
  ): Promise<EmbeddingResult | null> {
    if (!this._useWorkerQueue) {
      return null;
    }
    try {
      const queue = await this.ensureQueue();
      const targetDimension = this._targetDimensions ?? DEFAULT_EMBEDDING_DIMENSION;
      const response = await queue.add({
        kind: 'embed',
        id: this.createTaskId(),
        model: modelId,
        texts: [text],
        ...(this._targetDimensions ? { truncateDim: this._targetDimensions } : {}),
        targetDimension,
        deviceHint: this.resolveDeviceHint(),
        dtype: this.resolveQueueDType(),
        maxBatchSize: 1,
      });
      const vector = response.vectors[0];
      if (!vector) {
        throw new Error('Embedding worker returned no vectors');
      }
      const embedding = Array.from(vector) as number[];
      const dimensions = response.metadata.dimensions ?? embedding.length;
      TransformersBackend._inferenceCount += 1;
      return {
        embedding,
        dimensions,
        model: modelId,
      };
    } catch {
      this._useWorkerQueue = false;
      this._queue = null;
      return null;
    }
  }

  private async ensureQueue(): Promise<QueueAdapter> {
    if (this._queue) {
      return this._queue;
    }
    const queue = await getBrowserQueue();
    this._queue = queue;
    return queue;
  }

  private createTaskId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `embed-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }

  private resolveDeviceHint(): 'webgpu' | 'wasm' | 'auto' {
    if (this._selectedDevice === 'webgpu') {
      return 'webgpu';
    }
    if (this._selectedDevice === 'wasm') {
      return 'wasm';
    }
    return 'auto';
  }

  private resolveQueueDType(): EmbeddingDType {
    return (
      this._selectedDType ??
      this.resolveDTypeForDevice(this._selectedDevice ?? 'wasm', this._quantized)
    );
  }

  /**
   * Get the selected device for inference
   */
  getSelectedDevice(): string | null {
    return this._selectedDevice;
  }

  /**
   * Provide downstream consumers with the target embedding dimensionality for truncation and metadata.
   */
  setTargetDimensions(dimensions: number | null): void {
    if (typeof dimensions === 'number' && Number.isFinite(dimensions) && dimensions > 0) {
      this._targetDimensions = Math.floor(dimensions);
    } else {
      this._targetDimensions = null;
    }
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
