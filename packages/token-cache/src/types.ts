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
export type TokenCacheEntry = {
  /** Root folder identifier */
  folderId: string;
  /** Relative file path within the folder */
  filePath: string;
  /** xxHash64 of file content for change detection */
  contentHash: string;
  /** File size in bytes */
  fileSize: number;
  /** File modification time in milliseconds (optional) */
  mtimeMs: number | null;
  /** Cached token count */
  tokenCount: number;
  /** Mode used for counting ('accurate' = tiktoken, 'heuristic' = char/4) */
  countingMode: TokenCountingMode;
  /** Encoding used for accurate mode (e.g., 'o200k_base') */
  modelEncoding: string | null;
  /** Timestamp when entry was created */
  createdAt?: string;
  /** Timestamp when entry was last updated */
  updatedAt?: string;
};

/**
 * Request to count tokens for a file
 */
export type TokenCountRequest = {
  /** Unique identifier for this request */
  id: string;
  /** File content to count tokens for */
  content: string;
  /** Counting mode to use */
  mode: TokenCountingMode;
};

/**
 * Result of token counting operation
 */
export type TokenCountResult = {
  /** Request identifier */
  id: string;
  /** Number of tokens counted */
  tokenCount: number;
  /** xxHash64 of content */
  contentHash: string;
  /** Mode that was used */
  mode: TokenCountingMode;
};

/**
 * Progress event emitted during batch token counting
 */
export type TokenCountProgress = {
  type: 'progress';
  /** Number of items completed */
  completed: number;
  /** Total items to process */
  total: number;
  /** Current item being processed (optional) */
  currentId?: string;
};

/**
 * Error event from token counting worker
 */
export type TokenCountError = {
  type: 'error';
  /** Request identifier that failed */
  id: string;
  /** Error message */
  message: string;
  /** Error cause/stack (optional) */
  cause?: string;
};

/**
 * Worker message types
 */
export type TokenWorkerMessage = TokenCountProgress | TokenCountError;

/**
 * Statistics about the token cache
 */
export type TokenCacheStats = {
  /** Total number of cached entries */
  entryCount: number;
  /** Total tokens across all cached files */
  totalTokens: number;
  /** Number of entries using accurate counting */
  accurateCount: number;
  /** Number of entries using heuristic counting */
  heuristicCount: number;
};

/**
 * Options for the token cache store
 */
export type TokenCacheStoreOptions = {
  /** Whether to log debug information */
  debug?: boolean;
};

/**
 * File metadata for quick cache validation
 */
export type FileMetadata = {
  /** File size in bytes */
  size: number;
  /** Modification time in milliseconds (if available) */
  mtimeMs?: number;
};
