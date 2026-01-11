/**
 * Configuration for the embedding service
 */
export type EmbeddingConfig = {
  /** Model ID for the embedding model */
  modelId: string;
  /** Device preference (no automatic fallbacks) */
  device?: 'webgpu' | 'wasm';
  /** Quantization level */
  quantized?: boolean;
  /** Model revision/version */
  revision?: string;
  /** Cache directory for models */
  cacheDir?: string;
};

/**
 * Model registry entry
 */
export type ModelConfig = {
  /** Hugging Face model ID or API model identifier */
  id: string;
  /** Display name for UI */
  name: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Whether to use quantization */
  quantized?: boolean;
  /** Description for UI */
  description: string;
  /** Model tags for categorization */
  tags: string[];
  /** Model origin/type */
  origin?: string;
  /** Approximate download size (for local models) */
  size?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Supported dimension ranges for flexible models */
  supportedDimensions?: number[] | string;
  /** Price per 1M tokens (for hosted models) */
  pricePer1MTokens?: number;
};

/**
 * Hosted model configuration (subset of ModelConfig for API-based models)
 */
export type HostedModelConfig = {
  /** Display name for UI */
  name: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Description for UI */
  description: string;
  /** Model tags for categorization */
  tags: string[];
  /** Context window size in tokens */
  contextWindow: number;
  /** Price per 1M tokens */
  pricePer1MTokens: number;
  /** Supported dimension ranges for flexible models */
  supportedDimensions?: string;
};

/**
 * Model registry structure
 */
export type ModelRegistry = {
  /** Default model key */
  default: string;
  /** Available local models */
  models: Record<string, ModelConfig>;
  /** Hosted/API models by provider */
  hosted?: {
    openai?: Record<string, HostedModelConfig>;
    voyage?: Record<string, HostedModelConfig>;
    cohere?: Record<string, HostedModelConfig>;
    google?: Record<string, HostedModelConfig>;
  };
};

/**
 * Result of embedding generation
 */
export type EmbeddingResult = {
  /** The generated embedding vector */
  embedding: number[];
  /** Dimensions of the embedding */
  dimensions: number;
  /** Model used for generation */
  model: string;
  /** Token usage information */
  usage?: {
    totalTokens?: number;
  };
};

/**
 * Result of similarity calculation between two embeddings
 */
export type SimilarityResult = {
  /** Similarity score (0-1) */
  similarity: number;
  /** Distance score (0-2) */
  distance: number;
  /** Method used for calculation */
  method: 'cosine' | 'euclidean' | 'manhattan' | 'l2' | 'dot_product';
};

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
export type EmbeddingProgress = {
  /** Current stage */
  stage: 'initializing' | 'downloading' | 'processing' | 'ready' | 'error';
  /** Progress percentage (0-100) */
  progress?: number;
  /** Status message */
  message?: string;
  /** File being downloaded */
  file?: string;
  /** Downloaded bytes */
  loaded?: number;
  /** Total bytes */
  total?: number;
};

/**
 * Main embedding service interface
 */
export type EmbeddingService = {
  /** Initialize the service with given configuration */
  initialize(
    config?: Partial<EmbeddingConfig>,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void>;

  /** Generate embedding for a single text */
  generateEmbedding(text: string): Promise<EmbeddingResult>;

  /** Generate embeddings for multiple texts */
  generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]>;

  /** Generate an embedding optimized for documents/passages (indexing) */
  generateDocEmbedding(text: string): Promise<EmbeddingResult>;

  /** Generate an embedding optimized for search queries */
  generateQueryEmbedding(text: string): Promise<EmbeddingResult>;

  /** Calculate similarity between two embeddings */
  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult;

  /** Get current status */
  getStatus(): EmbeddingStatus;

  /** Get current configuration */
  getConfig(): EmbeddingConfig;

  /** Dispose of resources */
  dispose(): Promise<void>;
};

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
