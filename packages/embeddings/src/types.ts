/**
 * Configuration for the embedding service
 */
export interface EmbeddingConfig {
  /** Model ID for BGE-M3 */
  modelId: string;
  /** Device preference - will fallback automatically */
  device?: 'webgpu' | 'wasm' | 'cpu';
  /** Quantization level */
  quantized?: boolean;
  /** Model revision/version */
  revision?: string;
  /** Cache directory for models */
  cacheDir?: string;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingResult {
  /** The generated embedding vector */
  embedding: number[];
  /** Dimensions of the embedding */
  dimensions: number;
  /** Model used for generation */
  model: string;
}

/**
 * Result of similarity calculation between two embeddings
 */
export interface SimilarityResult {
  /** Similarity score (0-1) */
  similarity: number;
  /** Distance score (0-2) */
  distance: number;
  /** Method used for calculation */
  method: 'cosine' | 'euclidean' | 'manhattan';
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
}

/**
 * Main embedding service interface
 */
export interface EmbeddingService {
  /** Initialize the service with given configuration */
  initialize(
    config?: Partial<EmbeddingConfig>,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void>;

  /** Generate embedding for a single text */
  generateEmbedding(text: string): Promise<EmbeddingResult>;

  /** Calculate similarity between two embeddings */
  calculateSimilarity(embedding1: number[], embedding2: number[]): SimilarityResult;

  /** Get current status */
  getStatus(): EmbeddingStatus;

  /** Get current configuration */
  getConfig(): EmbeddingConfig;

  /** Dispose of resources */
  dispose(): Promise<void>;
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
 * Alternative smaller model for testing/fallback
 */
export const FALLBACK_MODEL_CONFIG = {
  /** Fallback model ID - smaller and more reliable */
  modelId: 'Xenova/all-MiniLM-L6-v2',
  /** Embedding dimensions */
  dimensions: 384,
  /** Maximum input length */
  maxLength: 512,
  /** Supported languages */
  supportedLanguages: ['en'],
  /** Retrieval modes */
  retrievalModes: ['dense'] as const,
} as const;

export type RetrievalMode = (typeof BGE_M3_CONFIG.retrievalModes)[number];
