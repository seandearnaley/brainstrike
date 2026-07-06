/**
 * Background Token Indexer Worker
 *
 * A dedicated Web Worker that handles the complete token indexing pipeline:
 * 1. Receives FileSystemFileHandle via postMessage
 * 2. Reads file content off the main thread
 * 3. Hashes content with xxHash64
 * 4. Estimates tokens with the shared local estimator
 * 5. Posts results back to main thread
 *
 * This keeps ALL heavy computation off the main thread, ensuring smooth UI.
 */

/// <reference lib="webworker" />

import { countTokensForMode } from './token-counting-runtime';
import type { TokenCountingMode } from './types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log level priority (higher = more severe)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default to 'info' to suppress debug logs - set WORKER_LOG_LEVEL=debug for verbose output
const WORKER_LOG_LEVEL: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[WORKER_LOG_LEVEL];
}

export interface WorkerLog {
  data?: Record<string, unknown> | undefined;
  level: LogLevel;
  message: string;
  type: 'log';
}

function formatError(error: unknown): {
  message: string;
  stack?: string;
  name?: string;
  cause?: string;
} {
  if (error instanceof Error) {
    const formatted: { message: string; stack?: string; name?: string; cause?: string } = {
      message: error.message,
    };
    if (error.stack) {
      formatted.stack = error.stack;
    }
    if (error.name) {
      formatted.name = error.name;
    }
    if (error.cause) {
      formatted.cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    }
    return formatted;
  }
  return { message: String(error) };
}

function postLog(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  try {
    const payload: WorkerLog = data
      ? { type: 'log', level, message, data }
      : { type: 'log', level, message };
    self.postMessage(payload);
  } catch {
    // Ignore structured-clone errors; console log still fired below
  }
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  // Use appropriate console method based on level to avoid red errors for info logs
  // biome-ignore lint/suspicious/noConsole: worker diagnostics must surface via console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[BackgroundTokenIndexerWorker]', message, data ?? '');
  postLog(level, message, data);
}

// Message types for worker communication
export interface IndexerRequest {
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

export interface IndexerError {
  compositeKey: string;
  error: string;
  id: string;
  type: 'error';
}

export type WorkerMessage = IndexerRequest | IndexerBatchRequest;
export type WorkerResponse = IndexerResult | IndexerProgress | IndexerError | WorkerLog;

// Lazy-loaded modules
interface XXHashModule {
  h64: (input: string) => bigint;
}

let hasherInstance: XXHashModule | null = null;
let tokenUtilsPromise: Promise<{
  supportsAccurateTokenCounting: () => Promise<boolean>;
  getAccurateTokenCountingFailureReason: () => string | null;
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> | null = null;

self.addEventListener('error', (event) => {
  const payload = {
    type: event.type,
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error ? formatError(event.error) : undefined,
  };
  log('error', 'global error event', payload);
  self.postMessage({
    type: 'error',
    id: '__init__',
    compositeKey: '__init__',
    error: `global error: ${payload.message ?? 'unknown'}`,
  } satisfies IndexerError);
});

self.addEventListener('unhandledrejection', (event) => {
  const formatted = formatError(event.reason);
  log('error', 'unhandledrejection', { reason: formatted });
  self.postMessage({
    type: 'error',
    id: '__init__',
    compositeKey: '__init__',
    error: `unhandledrejection: ${formatted.message}`,
  } satisfies IndexerError);
});

/**
 * Convert bigint hash to hex string
 */
function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

/**
 * Initialize xxHash WASM
 */
async function initHasher(): Promise<XXHashModule> {
  if (hasherInstance) {
    return hasherInstance;
  }

  const xxhashModule = await import('xxhash-wasm');
  const xxhashFn = typeof xxhashModule.default === 'function' ? xxhashModule.default : xxhashModule;
  hasherInstance = (await (xxhashFn as () => Promise<XXHashModule>)()) as XXHashModule;
  return hasherInstance;
}

/**
 * Lazy load token counting utilities
 */
async function getTokenUtils(): Promise<{
  supportsAccurateTokenCounting: () => Promise<boolean>;
  getAccurateTokenCountingFailureReason: () => string | null;
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> {
  if (!tokenUtilsPromise) {
    tokenUtilsPromise = import('./token-utils-lite')
      .then((mod) => ({
        supportsAccurateTokenCounting: mod.supportsAccurateTokenCounting,
        getAccurateTokenCountingFailureReason: mod.getAccurateTokenCountingFailureReason,
        countTokensAccurate: mod.countTokensAccurate,
        countTokensHeuristic: mod.countTokensHeuristic,
      }))
      .catch((error) => {
        const formatted = formatError(error);
        log('error', 'getTokenUtils failed', formatted);
        throw error;
      });
  }
  return tokenUtilsPromise;
}

/**
 * Check if content appears to be binary
 */
function isBinaryContent(content: string): boolean {
  // Check for null bytes or high ratio of non-printable characters
  const sampleSize = Math.min(content.length, 8192);
  let nonPrintable = 0;

  for (let i = 0; i < sampleSize; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) {
      return true; // Null byte = definitely binary
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }

  return nonPrintable / sampleSize > 0.1; // More than 10% non-printable = binary
}

/**
 * Read file content - uses pre-loaded content for Electron, FileSystemFileHandle for Web
 */
async function readFileContent(
  request: Omit<IndexerRequest, 'type'>
): Promise<{ content: string; fileSize: number }> {
  // Pre-loaded content (required for Electron, optional optimization for Web)
  if (request.content !== undefined) {
    const fileSize = request.fileSize ?? new Blob([request.content]).size;
    return { content: request.content, fileSize };
  }

  // Web File System Access API (works in workers)
  if (request.fileHandle) {
    const file = await request.fileHandle.getFile();
    return { content: await file.text(), fileSize: file.size };
  }

  throw new Error(
    'No file content available - Electron files must have content pre-loaded via IPC'
  );
}

/**
 * Process a single file: read, hash, count tokens
 */
async function processFile(
  request: Omit<IndexerRequest, 'type'>,
  hasher: XXHashModule
): Promise<IndexerResult | IndexerError> {
  const startTime = performance.now();

  try {
    log('debug', 'processFile start', {
      id: request.id,
      compositeKey: request.compositeKey,
      filePath: request.filePath,
      mode: request.mode,
      hasCachedHash: Boolean(request.cachedHash),
      hasFileHandle: Boolean(request.fileHandle),
      hasContent: request.content !== undefined,
    });
    // Read file content using appropriate method
    const { content, fileSize } = await readFileContent(request);
    log('debug', 'processFile file read', { fileSize });

    // Check for binary content
    if (isBinaryContent(content)) {
      log('warn', 'processFile binary content detected', {
        id: request.id,
        filePath: request.filePath,
      });
      return {
        type: 'error',
        id: request.id,
        compositeKey: request.compositeKey,
        error: 'Binary file - cannot count tokens',
      };
    }

    // Hash content
    const contentHash = hashToHex(hasher.h64(content));
    log('debug', 'processFile hashed', { contentHash });

    // Check if hash matches cached - skip counting if so
    if (request.cachedHash && request.cachedHash === contentHash) {
      const elapsedMs = performance.now() - startTime;
      log('debug', 'processFile cache hit; skipping count', { id: request.id, elapsedMs });
      return {
        type: 'result',
        id: request.id,
        compositeKey: request.compositeKey,
        folderId: request.folderId,
        filePath: request.filePath,
        tokenCount: 0, // Will use cached count
        contentHash,
        mode: request.mode,
        fileSize,
        skipped: true,
        elapsedMs,
      };
    }

    // Count tokens
    const tokenCount = await countTokensForMode(request.mode, content, getTokenUtils);
    const elapsedMs = performance.now() - startTime;
    log('debug', 'processFile token counted', { tokenCount, mode: request.mode, elapsedMs });

    return {
      type: 'result',
      id: request.id,
      compositeKey: request.compositeKey,
      folderId: request.folderId,
      filePath: request.filePath,
      tokenCount,
      contentHash,
      mode: request.mode,
      fileSize,
      skipped: false,
      elapsedMs,
    };
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processFile failed', {
      ...formatted,
      id: request.id,
      filePath: request.filePath,
    });
    return {
      type: 'error',
      id: request.id,
      compositeKey: request.compositeKey,
      error: formatted.message,
    };
  }
}

const TERMINAL_TOKENIZATION_ERROR_PATTERNS: RegExp[] = [
  /^accurate token counting unavailable:/i,
  /tiktoken encoder failed to initialize/i,
];

function normalizeTerminalErrorMessage(errorMessage: string): string {
  return errorMessage.trim().replace(/^error:\s*/i, '');
}

function isTerminalTokenizationError(errorMessage: string): boolean {
  const normalized = normalizeTerminalErrorMessage(errorMessage);
  return TERMINAL_TOKENIZATION_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Process a batch of files with progress reporting
 */
async function processBatch(requests: Omit<IndexerRequest, 'type'>[]): Promise<void> {
  if (requests.length === 0) {
    return;
  }

  log('debug', 'processBatch start', { total: requests.length });

  try {
    // Pre-initialize hashing once. Token estimation does not need tokenizer
    // runtime startup.
    const hasher = await initHasher();

    const total = requests.length;

    for (const [i, request] of requests.entries()) {
      log('debug', 'processBatch item start', { index: i, total, id: request.id });
      const result = await processFile(request, hasher);

      // Fail fast only when the tokenizer runtime is unavailable. File-content
      // tokenization failures must stay file-scoped and must not poison the worker.
      if (result.type === 'error' && isTerminalTokenizationError(result.error)) {
        throw new Error(result.error);
      }

      self.postMessage(result);
      log('debug', 'processBatch item posted', {
        index: i,
        total,
        id: request.id,
        type: result.type,
      });

      // Report progress
      self.postMessage({
        type: 'progress',
        completed: i + 1,
        total,
        currentId: request.id,
      } satisfies IndexerProgress);

      // Yield to prevent blocking (every 5 files)
      if (i % 5 === 0 && i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processBatch failed', formatted);
    self.postMessage({
      type: 'error',
      id: '__batch__',
      compositeKey: '__batch__',
      error: formatted.message,
    } satisfies IndexerError);
  }
}

// Handle incoming messages
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    log('debug', 'onmessage received', { type: (message as { type?: unknown }).type });
    if (message.type === 'index') {
      const hasher = await initHasher();
      const result = await processFile(message, hasher);
      self.postMessage(result);
    } else if (message.type === 'index-batch') {
      await processBatch(message.requests);
    } else {
      log('warn', 'Unknown message type', { type: (message as { type?: unknown }).type });
    }
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'onmessage handler failed', {
      type: (message as { type?: unknown }).type,
      error: formatted,
    });
    self.postMessage({
      type: 'error',
      id: '__init__',
      compositeKey: '__init__',
      error: formatted.message,
    } satisfies IndexerError);
  }
};

const bootstrap = async (): Promise<void> => {
  try {
    await initHasher();
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'worker bootstrap failed', formatted);
    self.postMessage({
      type: 'error',
      id: '__init__',
      compositeKey: '__init__',
      error: `bootstrap failed: ${formatted.message}`,
    } satisfies IndexerError);
    return;
  }

  self.postMessage({ type: 'ready' });
};

void bootstrap();
