/**
 * Messages between the background token indexer worker and its main-thread
 * owner. Main-thread code imports these from here, never from the worker
 * module, so its programs do not take on the worker's `webworker` lib.
 */
import type { TokenCountingMode } from './types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface WorkerLog {
  data?: Record<string, unknown> | undefined;
  level: LogLevel;
  message: string;
  type: 'log';
}

export interface IndexerRequest {
  /** Cached byte size. Required as the secondary signal whenever cachedHash is present. */
  cachedFileSize: number | undefined;
  cachedHash: string | undefined; // If provided, skip if hash matches
  compositeKey: string;
  /** Pre-loaded file content (required for Electron, optional for Web) */
  content?: string;
  /** Web FileSystemFileHandle for File System Access API (Web only) */
  fileHandle?: FileSystemFileHandle;
  filePath: string;
  /** Pre-loaded file size in bytes */
  fileSize?: number;
  folderId: string;
  id: string;
  mode: TokenCountingMode;
  type: 'index';
}

export interface IndexerBatchRequest {
  requests: Omit<IndexerRequest, 'type'>[];
  type: 'index-batch';
}

export interface IndexerResult {
  compositeKey: string;
  contentHash: string;
  /** Time taken to process this file (ms) */
  elapsedMs: number;
  filePath: string;
  fileSize: number;
  folderId: string;
  id: string;
  mode: TokenCountingMode;
  skipped: boolean; // True if hash matched and counting was skipped
  tokenCount: number;
  type: 'result';
}

export interface IndexerProgress {
  completed: number;
  currentId: string;
  total: number;
  type: 'progress';
}

/**
 * Why a file produced no token count.
 *
 * `'binary'` is an EXPECTED outcome, not a failure: the file was read fine and
 * simply has no meaningful token count. It is carried as a closed literal union
 * rather than re-derived from the message prose, so consumers deciding severity
 * and retry never string-match a sentence that is free to be reworded.
 *
 * Absent means a genuine failure (read error, hashing, tokenizer) whose only
 * description is `error`.
 */
export type IndexerErrorReason = 'binary';

export interface IndexerError {
  compositeKey: string;
  error: string;
  id: string;
  reason?: IndexerErrorReason;
  type: 'error';
}

export type WorkerMessage = IndexerRequest | IndexerBatchRequest;
export type WorkerResponse = IndexerResult | IndexerProgress | IndexerError | WorkerLog;
