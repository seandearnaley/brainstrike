import { type EmbeddingDType, StreamingEmbeddingWorkerClient } from '@brainstrike/embedding-worker';
import type { QueueAdapter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { getRegisteredEmbeddingQueueFactory } from './runtime-config';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingStreamBatch,
  EmbeddingStreamOptions,
  EmbeddingWorkerRuntimeMetadata,
  ModelConfig,
} from './types';

const logger = createLogger('TransformersBackend');

// Type definitions for transformers.js
interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    config: PipelineConfig
  ) => Promise<FeatureExtractionPipeline>;
}

/**
 * Options for FeatureExtractionPipeline._call().
 *
 * Note: Truncation is handled internally by the pipeline - it passes
 * `truncation: true` to the tokenizer automatically. The tokenizer uses
 * the model's configured `model_max_length`.
 *
 * See: https://huggingface.co/docs/transformers.js/api/pipelines#featureextractionpipeline
 */
interface FeatureExtractionPipelineOptions {
  normalize: boolean;
  pooling: string;
  precision?: 'binary' | 'ubinary';
  quantize?: boolean;
}

type FeatureExtractionPipeline = (
  text: string,
  options: FeatureExtractionPipelineOptions
) => Promise<{
  data: Float32Array;
}>;

interface PipelineConfig {
  device?: string;
  dtype?: string;
  progressCallback?: (progress: ProgressInfo) => void;
  quantized?: boolean;
}

interface ProgressInfo {
  file?: string;
  loaded?: number;
  status: string;
  total?: number;
}

interface DownloadOptions {
  cacheDir?: string;
  onProgress?: (progress: ProgressInfo) => void;
}

// Cache the imported module to avoid duplicate imports across instances
let transformersModule: TransformersModule | null = null;
let transformersModulePromise: Promise<TransformersModule> | null = null;

function supportsWorkerQueue(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

async function getBrowserQueue(): Promise<QueueAdapter> {
  const customQueueFactory = getRegisteredEmbeddingQueueFactory();
  if (customQueueFactory) {
    return Promise.resolve(customQueueFactory());
  }
  // No implicit queue bootstrap is allowed here. The app runtime must register the queue
  // factory explicitly before embedding initialization so worker URLs and lifecycle stay
  // under the owning platform's control.
  throw new Error(
    'Embedding queue factory is not registered. Register an explicit queue with a workerUrl before initializing the transformers backend.'
  );
}

async function getTransformersModule(): Promise<TransformersModule> {
  if (transformersModule) {
    return transformersModule;
  }
  if (!transformersModulePromise) {
    transformersModulePromise = import(
      /* @vite-ignore */ '@huggingface/transformers'
    ) as Promise<TransformersModule>;
  }
  transformersModule = await transformersModulePromise;
  return transformersModule;
}

/**
 * Build a user-friendly error message for device unavailability (BST-169)
 */
function buildDeviceUnavailableError(device: 'webgpu' | 'wasm', reason?: string): Error {
  const suggestions: string[] = [];

  if (device === 'webgpu') {
    if (reason?.includes('API not available') || !reason) {
      suggestions.push(
        'Use a browser that supports WebGPU (Chrome 113+, Edge 113+, or Safari 18+)',
        'Enable WebGPU flag if using an older browser version',
        'Use WASM as an alternative (set device: "wasm")'
      );
    } else if (reason?.includes('No WebGPU adapter')) {
      suggestions.push(
        'Update your GPU drivers to the latest version',
        'Ensure your GPU supports WebGPU (most GPUs from 2016+ should work)',
        'Check that hardware acceleration is enabled in browser settings',
        'Use WASM mode as fallback (set device: "wasm")'
      );
    } else {
      suggestions.push(
        'Check browser and GPU compatibility',
        'Update GPU drivers',
        'Use WASM as a fallback (set device: "wasm")'
      );
    }

    return new Error(
      'WebGPU Acceleration Unavailable\n\n' +
        `${reason || 'WebGPU is not available in this environment.'}\n\n` +
        `Suggestions:\n${suggestions.map((s) => `  • ${s}`).join('\n')}\n\n` +
        `Recommended fallback: WASM (set device: "wasm" in configuration)`
    );
  }

  // WASM unavailable
  return new Error(
    'WebAssembly Unavailable\n\n' +
      'WebAssembly is required for embedding generation but is not available.\n\n' +
      'Suggestions:\n' +
      '  • Use a modern browser (Chrome, Firefox, Safari, or Edge)\n' +
      '  • Disable browser extensions that may block WebAssembly\n' +
      '  • Check browser security settings'
  );
}

/**
 * Determine the device to use for local embeddings.
 * No automatic fallback is permitted; invalid or unsupported selections throw.
 * Provides user-friendly error messages with actionable suggestions (BST-169).
 */
function determineDevice(requestedDevice: string | undefined): 'webgpu' | 'wasm' {
  if (requestedDevice === 'webgpu') {
    if (!TransformersBackend.isDeviceAvailable('webgpu')) {
      const reason =
        typeof navigator !== 'undefined' && 'gpu' in navigator
          ? 'WebGPU API is present but no adapter could be obtained. This may indicate a GPU driver issue.'
          : 'WebGPU API is not available in this browser.';
      throw buildDeviceUnavailableError('webgpu', reason);
    }
    return 'webgpu';
  }

  if (requestedDevice === 'wasm') {
    if (typeof WebAssembly === 'undefined') {
      throw buildDeviceUnavailableError('wasm');
    }
    return 'wasm';
  }

  if (requestedDevice === 'cpu') {
    throw new Error(
      'CPU embeddings are disabled for performance reasons.\n\n' +
        'Please choose one of the supported acceleration methods:\n' +
        '  • webgpu - GPU acceleration (fastest, requires WebGPU support)\n' +
        '  • wasm - WebAssembly (slower but widely compatible)\n\n' +
        'Set device: "webgpu" or device: "wasm" in your configuration.'
    );
  }

  // Auto-detect: prefer WebGPU if available
  if (TransformersBackend.isDeviceAvailable('webgpu')) {
    logger.info('Auto-selected WebGPU for embedding inference');
    return 'webgpu';
  }

  // Throw with guidance instead of silently failing
  throw new Error(
    'No supported embedding device available.\n\n' +
      'WebGPU was not detected in this environment. To use embeddings:\n' +
      '  • Explicitly set device: "wasm" for WASM-based inference\n' +
      '  • Or use a WebGPU-capable browser (Chrome 113+, Edge 113+)\n\n' +
      'Example: new TransformersEmbeddingProvider("model-key", "wasm")'
  );
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
  private _selectedDevice: 'webgpu' | 'wasm' | null = null;
  private _isInitialized = false;
  private _quantized: boolean | undefined;
  private _useWorkerQueue = false;
  private _queue: QueueAdapter | null = null;
  private _streamingClient: StreamingEmbeddingWorkerClient | null = null;
  private _streamingWorkerUrl: string | null = null;
  private _streamBatchSize: number | null = null;
  private _targetDimensions: number | null = null;
  private _selectedDType: EmbeddingDType | null = null;

  private resolveDTypeForDevice(device: 'webgpu' | 'wasm', quantized?: boolean): EmbeddingDType {
    if (device === 'webgpu') {
      return 'fp16';
    }
    if (device === 'wasm') {
      return quantized ? 'q4' : 'fp32';
    }
    throw new Error(`Unsupported embedding device "${device}".`);
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

    this._selectedDevice = determineDevice(config.device);
    this._quantized = config.quantized;
    this._selectedDType = this.resolveDTypeForDevice(this._selectedDevice, this._quantized);
    this._streamingWorkerUrl = config.streamingWorkerUrl ?? null;
    this._streamBatchSize = this.resolveStreamBatchSize(config.streamBatchSize);

    if (TransformersBackend._verboseOrtLogs) {
      logger.debug(
        'Verbose ORT logging requested; worker-based embeddings emit logs from the worker context.'
      );
    }

    if (!supportsWorkerQueue()) {
      throw new Error('Embedding worker queue required; Web Workers are unavailable.');
    }

    onProgress?.({
      message: 'Preparing embedding runtime...',
      progress: 10,
      stage: 'processing',
    });
    this._queue = await getBrowserQueue();
    this._useWorkerQueue = true;
    this._isInitialized = true;
    onProgress?.({
      message: 'Model ready!',
      progress: 100,
      stage: 'ready',
    });
  }

  /**
   * Generate embedding for a given text
   */
  async generateEmbedding(text: string, modelId: string): Promise<EmbeddingResult> {
    if (!this._isInitialized) {
      throw new Error('Backend not initialized. Call initialize() first.');
    }
    return this.tryGenerateWithQueue(text, modelId);
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts: string[], modelId: string): Promise<EmbeddingResult[]> {
    if (!this._isInitialized) {
      throw new Error('Backend not initialized. Call initialize() first.');
    }
    return this.tryGenerateBatchWithQueue(texts, modelId);
  }

  async generateEmbeddingsStream(
    texts: string[],
    modelId: string,
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void,
    options?: EmbeddingStreamOptions
  ): Promise<undefined | EmbeddingWorkerRuntimeMetadata> {
    if (!this._isInitialized) {
      throw new Error('Backend not initialized. Call initialize() first.');
    }
    if (texts.length === 0) {
      return;
    }

    const client = this.ensureStreamingClient();
    try {
      const metadata = await client.stream(
        this.createWorkerRequest(texts, modelId, options?.streamBatchSize),
        {
          onBatch: async (event) => {
            const results = event.vectors.map((vector) => {
              const embedding = Array.from(vector) as number[];
              return {
                dimensions: embedding.length,
                embedding,
                model: modelId,
              };
            });
            await onBatch({
              endIndex: event.endIndex,
              results,
              startIndex: event.startIndex,
            });
          },
        }
      );

      TransformersBackend._inferenceCount += texts.length;
      return {
        device: metadata.device,
        dtype: metadata.dtype,
        fallbackApplied: metadata.fallbackApplied,
      };
    } catch (error) {
      logger.debug('Embedding worker streaming failed', {
        batchSize: texts.length,
        error,
        modelId,
      });
      throw error;
    }
  }

  private async tryGenerateWithQueue(text: string, modelId: string): Promise<EmbeddingResult> {
    const batch = await this.tryGenerateBatchWithQueue([text], modelId);
    const first = batch[0];
    if (!first) {
      throw new Error('Embedding worker returned no vector');
    }
    return first;
  }

  private async tryGenerateBatchWithQueue(
    texts: string[],
    modelId: string
  ): Promise<EmbeddingResult[]> {
    if (!this._useWorkerQueue) {
      throw new Error('Embedding worker queue required; inline pipeline disabled.');
    }
    try {
      const queue = await this.ensureQueue();
      const response = await queue.add(this.createWorkerRequest(texts, modelId));

      if (!response.vectors || response.vectors.length === 0) {
        // If input was empty, return empty
        if (texts.length === 0) {
          return [];
        }
        throw new Error('Embedding worker returned no vectors');
      }

      TransformersBackend._inferenceCount += texts.length;

      return response.vectors.map((vector) => {
        const embedding = Array.from(vector) as number[];
        return {
          dimensions: response.metadata.dimensions ?? embedding.length,
          embedding,
          model: modelId,
          runtime: {
            device: response.metadata.device,
            dtype: response.metadata.dtype,
            fallbackApplied: response.metadata.fallbackApplied,
          },
        };
      });
    } catch (error) {
      logger.error('Embedding worker queue failed', {
        batchSize: texts.length,
        error,
        modelId,
      });
      throw error;
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

  private ensureStreamingClient(): StreamingEmbeddingWorkerClient {
    if (this._streamingClient) {
      return this._streamingClient;
    }
    if (!this._streamingWorkerUrl) {
      throw new Error(
        'TransformersBackend requires an explicit streamingWorkerUrl for streamed local embeddings.'
      );
    }
    this._streamingClient = new StreamingEmbeddingWorkerClient({
      workerUrl: this._streamingWorkerUrl,
    });
    return this._streamingClient;
  }

  private createTaskId(): string {
    return `embed-${generateUUID()}`;
  }

  private createWorkerRequest(texts: string[], modelId: string, streamBatchSize?: number) {
    const targetDimension = this._targetDimensions ?? DEFAULT_EMBEDDING_DIMENSION;
    return {
      id: this.createTaskId(),
      kind: 'embed' as const,
      model: modelId,
      texts,
      type: 'embed' as const,
      ...(this._targetDimensions ? { truncateDim: this._targetDimensions } : {}),
      deviceHint: this.resolveDeviceHint(),
      dtype: this.resolveQueueDType(),
      maxBatchSize: this.resolveWorkerMaxBatchSize(texts.length, streamBatchSize),
      targetDimension,
    };
  }

  private resolveStreamBatchSize(value: number | undefined): number | null {
    if (value === undefined) {
      return null;
    }
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
    throw new Error(`streamBatchSize must be a positive integer, received "${String(value)}".`);
  }

  private resolveWorkerMaxBatchSize(textCount: number, streamBatchSize?: number): number {
    const batchSize = this.resolveStreamBatchSize(streamBatchSize) ?? this._streamBatchSize;
    return Math.max(1, Math.min(textCount, batchSize ?? textCount));
  }

  private resolveDeviceHint(): 'webgpu' | 'wasm' {
    if (this._selectedDevice === 'webgpu') {
      return 'webgpu';
    }
    if (this._selectedDevice === 'wasm') {
      return 'wasm';
    }
    throw new Error('Embedding device not initialized.');
  }

  private resolveQueueDType(): EmbeddingDType {
    if (!this._selectedDevice) {
      throw new Error('Embedding device not initialized.');
    }
    return this._selectedDType ?? this.resolveDTypeForDevice(this._selectedDevice, this._quantized);
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
      } catch (error) {
        logger.debug('Failed to dispose transformers pipeline', { error });
      }
    }

    this._pipeline = null;
    this._transformers = null;
    this._selectedDevice = null;
    this._isInitialized = false;
    this._streamingClient?.terminate();
    this._streamingClient = null;
  }

  /**
   * Static method to determine the best device for the current environment
   */
  static getBestDevice(): 'webgpu' | 'wasm' {
    if (TransformersBackend.isDeviceAvailable('webgpu')) {
      return 'webgpu';
    }
    if (TransformersBackend.isDeviceAvailable('wasm')) {
      return 'wasm';
    }
    throw new Error('No supported embedding device available.');
  }

  /**
   * Static method to check if a specific device is available
   */
  static isDeviceAvailable(device: string): boolean {
    switch (device) {
      case 'webgpu':
        try {
          return typeof navigator !== 'undefined' && 'gpu' in navigator;
        } catch (error) {
          logger.debug('navigator.gpu detection failed', { error });
          return false;
        }
      case 'wasm':
        return typeof window !== 'undefined';
      default:
        return false;
    }
  }

  /**
   * explicit download model to cache dir
   */
  async downloadModel(modelId: string, options?: DownloadOptions): Promise<void> {
    if (!this._transformers) {
      this._transformers = await getTransformersModule();
    }

    // Set cache dir if provided
    if (options?.cacheDir && this._transformers) {
      const transformers = this._transformers as unknown as {
        env?: { cacheDir?: string; allowLocalModels?: boolean };
      };
      if (transformers.env) {
        transformers.env.cacheDir = options.cacheDir;
        transformers.env.allowLocalModels = false; // Force download/check from hub
      }
    }

    const pipelineConfig: PipelineConfig = {
      progressCallback: (progress: ProgressInfo) => {
        if (options?.onProgress) {
          options.onProgress(progress);
        }
      },
    };

    // We just init the pipeline to trigger download
    // We don't need to keep it
    await this._transformers.pipeline('feature-extraction', modelId, pipelineConfig);
  }
}
