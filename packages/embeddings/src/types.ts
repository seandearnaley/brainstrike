import type { EmbeddingModelConfig } from '@brainstrike/indexing-contract';

export type ModelConfig = EmbeddingModelConfig;

/**
 * Configuration for the embedding service
 */
export interface EmbeddingConfig {
  /** Cache directory for models */
  cacheDir?: string;
  /** Device preference (no automatic fallbacks) */
  device?: 'webgpu' | 'wasm';
  /** Model ID for the embedding model */
  modelId: string;
  /** Quantization level */
  quantized?: boolean;
  /** Model revision/version */
  revision?: string;
  /** Maximum local streaming inference batch size. */
  streamBatchSize?: number;
  /** Explicit worker URL for streamed local embedding execution. */
  streamingWorkerUrl?: string;
}

/**
 * Hosted model configuration (subset of ModelConfig for API-based models)
 */
export interface HostedModelConfig {
  /** Context window size in tokens */
  contextWindow: number;
  /** Description for UI */
  description: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Display name for UI */
  name: string;
  /** Price per 1M tokens */
  pricePer1MTokens: number;
  /** Supported dimension ranges for flexible models */
  supportedDimensions?: string;
  /** Model tags for categorization */
  tags: string[];
}

/**
 * Model registry structure
 */
export interface ModelRegistry {
  /** Default model key */
  default: string;
  /** Hosted/API models by provider */
  hosted?: {
    openai?: Record<string, HostedModelConfig>;
    voyage?: Record<string, HostedModelConfig>;
    cohere?: Record<string, HostedModelConfig>;
    google?: Record<string, HostedModelConfig>;
  };
  /** Available local models */
  models: Record<string, ModelConfig>;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingResult {
  /** Dimensions of the embedding */
  dimensions: number;
  /** The generated embedding vector */
  embedding: number[];
  /** Model used for generation */
  model: string;
  /** Runtime metadata reported by the local embedding worker when available */
  runtime?: EmbeddingWorkerRuntimeMetadata;
  /** Token usage information */
  usage?: {
    totalTokens?: number;
  };
}

export interface EmbeddingWorkerRuntimeMetadata {
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: string;
  readonly fallbackApplied: boolean;
}

export interface EmbeddingStreamBatch {
  /** Exclusive batch end index within the original request order */
  endIndex: number;
  /** Embeddings produced for this slice */
  results: EmbeddingResult[];
  /** Inclusive batch start index within the original request order */
  startIndex: number;
}

/**
 * Result of similarity calculation between two embeddings
 */
export interface SimilarityResult {
  /** Distance score (0-2) */
  distance: number;
  /** Method used for calculation */
  method: 'cosine' | 'euclidean' | 'manhattan' | 'l2' | 'dot_product';
  /** Similarity score (0-1) */
  similarity: number;
}

/**
 * Status of the embedding service
 */
export type EmbeddingStatus =
  | 'idle'
  | 'initializing'
  | 'downloading'
  | 'ready'
  | 'processing'
  | 'error'
  | 'disposed';

/**
 * Progress information during model download
 */
export interface EmbeddingProgress {
  /** File being downloaded */
  file?: string;
  /** Downloaded bytes */
  loaded?: number;
  /** Status message */
  message?: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Current stage */
  stage: 'initializing' | 'downloading' | 'processing' | 'ready' | 'error';
  /** Total bytes */
  total?: number;
}

/**
 * Main embedding service interface
 */
export interface EmbeddingService {
  /** Calculate similarity between two embeddings */
  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult;

  /** Dispose of resources */
  dispose(): Promise<void>;

  /** Generate an embedding optimized for documents/passages (indexing) */
  generateDocEmbedding(text: string): Promise<EmbeddingResult>;

  /** Generate embedding for a single text */
  generateEmbedding(text: string): Promise<EmbeddingResult>;

  /** Generate embeddings for multiple texts */
  generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]>;

  /**
   * Stream embeddings for multiple texts in request order.
   * Local background embedding workers rely on this path so batches can be
   * persisted incrementally without retaining the full result set in memory.
   */
  generateEmbeddingsStream?(
    texts: string[],
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void
  ): Promise<unknown>;

  /** Generate an embedding optimized for search queries */
  generateQueryEmbedding(text: string): Promise<EmbeddingResult>;

  /** Get current configuration */
  getConfig(): EmbeddingConfig;

  /** Get current status */
  getStatus(): EmbeddingStatus;
  /** Initialize the service with given configuration */
  initialize(
    config?: Partial<EmbeddingConfig>,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void>;
}

/**
 * Error thrown by embedding service
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: Error
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * BGE-M3 specific configuration and constants
 */
export const BGE_M3_CONFIG = {
  /** Default model ID */
  modelId: 'Xenova/bge-m3',
  /** Embedding dimensions */
  dimensions: 1024,
  /** Maximum input length */
  maxLength: 8192,
  /** Supported languages (partial list) */
  supportedLanguages: ['en', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko'],
  /** Retrieval modes supported by BGE-M3 */
  retrievalModes: ['dense', 'sparse', 'colbert'] as const,
} as const;

/**
 * Alternative smaller model for testing/fallback.
 * Conforms to ModelConfig for use with initializeWithModel().
 */
export const FALLBACK_MODEL_CONFIG: ModelConfig = {
  id: 'Xenova/all-MiniLM-L6-v2',
  name: 'all-MiniLM-L6-v2',
  dimensions: 384,
  quantized: false,
  description: 'Small, fast general-purpose embedding model',
  tags: ['english', 'small', 'fast'],
  origin: 'HuggingFace',
  size: '~80MB',
};

export type RetrievalMode = (typeof BGE_M3_CONFIG.retrievalModes)[number];
