/**
 * Token Cache Types
 *
 * Core type definitions for the persistent token cache system.
 */

/**
 * Supported token counting modes
 */
export type TokenCountingMode = 'accurate' | 'heuristic';

/**
 * Entry stored in the persistent token cache (PGlite)
 */
export interface TokenCacheEntry {
  /** xxHash64 of file content for change detection */
  contentHash: string;
  /** Mode used for counting ('accurate' = tiktoken, 'heuristic' = char/4) */
  countingMode: TokenCountingMode;
  /** Timestamp when entry was created */
  createdAt?: string;
  /** Relative file path within the folder */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Root folder identifier */
  folderId: string;
  /** Encoding used for accurate mode (e.g., 'o200k_base') */
  modelEncoding: string | null;
  /** File modification time in milliseconds (optional) */
  mtimeMs: number | null;
  /** Cached token count */
  tokenCount: number;
  /** Timestamp when entry was last updated */
  updatedAt?: string;
}

/**
 * Request to count tokens for a file
 */
export interface TokenCountRequest {
  /** File content to count tokens for */
  content: string;
  /** Unique identifier for this request */
  id: string;
  /** Counting mode to use */
  mode: TokenCountingMode;
}

/**
 * Result of token counting operation
 */
export interface TokenCountResult {
  /** xxHash64 of content */
  contentHash: string;
  /** Request identifier */
  id: string;
  /** Mode that was used */
  mode: TokenCountingMode;
  /** Number of tokens counted */
  tokenCount: number;
}

/**
 * Progress event emitted during batch token counting
 */
export interface TokenCountProgress {
  /** Number of items completed */
  completed: number;
  /** Current item being processed (optional) */
  currentId?: string;
  /** Total items to process */
  total: number;
  type: 'progress';
}

/**
 * Error event from token counting worker
 */
export interface TokenCountError {
  /** Error cause/stack (optional) */
  cause?: string;
  /** Request identifier that failed */
  id: string;
  /** Error message */
  message: string;
  type: 'error';
}

/**
 * Worker message types
 */
export type TokenWorkerMessage = TokenCountProgress | TokenCountError;

/**
 * Statistics about the token cache
 */
export interface TokenCacheStats {
  /** Number of entries using accurate counting */
  accurateCount: number;
  /** Total number of cached entries */
  entryCount: number;
  /** Number of entries using heuristic counting */
  heuristicCount: number;
  /** Total tokens across all cached files */
  totalTokens: number;
}

/**
 * Options for the token cache store
 */
export interface TokenCacheStoreOptions {
  /** Whether to log debug information */
  debug?: boolean;
  /** Optional composition-layer telemetry sink for persistent cache lookups. */
  telemetry?: TokenCacheStoreTelemetry;
  /**
   * Base delay for transient batch retries, in milliseconds. Construction throws
   * RangeError if the largest configured exponential delay exceeds 2,147,483,647 ms.
   */
  transactionRetryBaseDelayMs?: number;
  /** Maximum number of attempts for transient batch transaction failures. */
  transactionRetryMaxAttempts?: number;
}

export interface TokenCacheLookupTelemetryRecord {
  readonly durationMs: number;
  readonly failed?: boolean;
  readonly hitCount: number;
  readonly lookupCount: number;
}

export interface TokenCacheStoreTelemetry {
  readonly recordLookup: (record: TokenCacheLookupTelemetryRecord) => void;
}

/**
 * File metadata for quick cache validation
 */
export interface FileMetadata {
  /** Modification time in milliseconds (if available) */
  mtimeMs?: number;
  /** File size in bytes */
  size: number;
}

export type TokenWorkerMethod =
  | 'countTokens'
  | 'countTokensBatch'
  | 'hashContent'
  | 'hashContentBatch';

export interface TokenWorkerRequest {
  method: TokenWorkerMethod;
  params: unknown[];
  requestId: string;
  type: 'request';
}

export interface TokenWorkerResponse {
  requestId: string;
  result: unknown;
  type: 'response';
}

export interface TokenWorkerResponseError {
  cause?: string;
  message: string;
  requestId: string;
  type: 'error';
}
