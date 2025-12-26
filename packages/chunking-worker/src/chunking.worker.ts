/**
 * Chunking Worker
 *
 * A dedicated Web Worker that handles all file chunking off the main thread:
 * 1. Receives file content and options via postMessage
 * 2. Parses code using @babel/parser (for JS/TS)
 * 3. Splits content using appropriate strategy
 * 4. Counts tokens using tiktoken
 * 5. Hashes content for deduplication
 * 6. Posts results back to main thread
 *
 * This keeps ALL heavy computation off the main thread, ensuring smooth UI.
 */

/// <reference lib="webworker" />

import { chunkContent, type PortableChunkingResult } from './portable-chunking';
import type {
  ChunkBatchRequest,
  ChunkError,
  ChunkingRequestOptions,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  WorkerLog,
  WorkerRequest,
} from './shared';

// ============================================================================
// Constants
// ============================================================================

/** Number of files between yields during batch processing */
const BATCH_YIELD_INTERVAL = 5;

/** Delay in ms when yielding during batch processing (0 = microtask) */
const YIELD_DELAY_MS = 0;

/** Timeout in ms for processing a single file */
const FILE_PROCESSING_TIMEOUT_MS = 60_000;

// ============================================================================
// Type Guards for Input Validation
// ============================================================================

/**
 * Validate that options object has the required structure for chunking.
 */
function isChunkingRequestOptions(value: unknown): value is ChunkingRequestOptions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const strategy = obj['strategy'];
  // strategy is required
  return strategy === 'sentence' || strategy === 'token' || strategy === 'recursive';
}

/**
 * Validate incoming chunk request structure before processing.
 * Prevents crashes from malformed or corrupted messages.
 */
function isChunkRequest(value: unknown): value is ChunkRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return (
    msg['type'] === 'chunk' &&
    typeof msg['id'] === 'string' &&
    typeof msg['fileRecordId'] === 'string' &&
    typeof msg['content'] === 'string' &&
    typeof msg['fileName'] === 'string' &&
    typeof msg['filePath'] === 'string' &&
    isChunkingRequestOptions(msg['options'])
  );
}

/**
 * Validate incoming batch request structure.
 */
function isChunkBatchRequest(value: unknown): value is ChunkBatchRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  if (msg['type'] !== 'chunk-batch' || !Array.isArray(msg['requests'])) {
    return false;
  }
  // Validate each request in the batch (except 'type' field which isn't required)
  for (const req of msg['requests']) {
    if (typeof req !== 'object' || req === null) {
      return false;
    }
    const r = req as Record<string, unknown>;
    if (
      typeof r['id'] !== 'string' ||
      typeof r['fileRecordId'] !== 'string' ||
      typeof r['content'] !== 'string' ||
      typeof r['fileName'] !== 'string' ||
      typeof r['filePath'] !== 'string' ||
      !isChunkingRequestOptions(r['options'])
    ) {
      return false;
    }
  }
  return true;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  // biome-ignore lint/suspicious/noConsole: worker diagnostics must surface via console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[ChunkingWorker]', message, data ?? '');
  postLog(level, message, data);
}

log('info', 'worker script evaluated');

// ============================================================================
// Global Error Handlers (with cleanup support)
// ============================================================================

/**
 * Handle global error events in the worker.
 */
function handleGlobalError(event: ErrorEvent): void {
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
    fileRecordId: '__init__',
    error: `global error: ${payload.message ?? 'unknown'}`,
  } satisfies ChunkError);
}

/**
 * Handle unhandled promise rejections in the worker.
 */
function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const formatted = formatError(event.reason);
  log('error', 'unhandledrejection', { reason: formatted });
  self.postMessage({
    type: 'error',
    id: '__init__',
    fileRecordId: '__init__',
    error: `unhandledrejection: ${formatted.message}`,
  } satisfies ChunkError);
}

// Register global error handlers
self.addEventListener('error', handleGlobalError);
self.addEventListener('unhandledrejection', handleUnhandledRejection);

/**
 * Clean up global error handlers (defensive cleanup for edge cases).
 * Called when worker receives a 'cleanup' message.
 */
function cleanupGlobalHandlers(): void {
  self.removeEventListener('error', handleGlobalError);
  self.removeEventListener('unhandledrejection', handleUnhandledRejection);
  log('info', 'Global error handlers cleaned up');
}

/**
 * Create a promise that rejects after a timeout.
 */
function createTimeout(ms: number, context: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Processing timeout after ${ms}ms: ${context}`));
    }, ms);
  });
}

/**
 * Process a single file with timeout protection.
 */
async function processFileWithTimeout(
  request: Omit<ChunkRequest, 'type'>,
  timeoutMs: number = FILE_PROCESSING_TIMEOUT_MS
): Promise<ChunkResult | ChunkError> {
  const context = `${request.fileName} (${request.id})`;
  try {
    return await Promise.race([processFile(request), createTimeout(timeoutMs, context)]);
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processFile timeout or race error', {
      ...formatted,
      id: request.id,
      fileRecordId: request.fileRecordId,
      fileName: request.fileName,
      phase: 'timeout',
    });
    const errorResult: ChunkError = {
      type: 'error',
      id: request.id,
      fileRecordId: request.fileRecordId,
      error: formatted.message,
    };
    if (formatted.stack !== undefined) {
      errorResult.stack = formatted.stack;
    }
    return errorResult;
  }
}

/**
 * Process a single file: chunk content
 */
async function processFile(request: Omit<ChunkRequest, 'type'>): Promise<ChunkResult | ChunkError> {
  const contentLength = request.content?.length ?? 0;
  const strategy = request.options?.strategy ?? 'unknown';

  try {
    log('debug', 'processFile start', {
      id: request.id,
      fileRecordId: request.fileRecordId,
      fileName: request.fileName,
      contentLength,
      strategy,
      phase: 'start',
    });

    const result: PortableChunkingResult = await chunkContent(request.content, {
      ...request.options,
      fileName: request.fileName,
      filePath: request.filePath,
    });

    log('info', 'processFile completed', {
      id: request.id,
      fileRecordId: request.fileRecordId,
      chunksCreated: result.chunks.length,
      totalTokens: result.totalTokens,
      strategyUsed: result.strategyUsed,
      skipped: result.skipped,
      phase: 'complete',
    });

    // Report progress for this file
    self.postMessage({
      type: 'progress',
      id: request.id,
      fileRecordId: request.fileRecordId,
      chunksCreated: result.chunks.length,
    } satisfies ChunkProgress);

    const chunkResult: ChunkResult = {
      type: 'result',
      id: request.id,
      fileRecordId: request.fileRecordId,
      chunks: result.chunks,
      strategyUsed: result.strategyUsed,
      totalTokens: result.totalTokens,
      skipped: result.skipped,
    };
    // Only include skipReason if it's defined (exactOptionalPropertyTypes compliance)
    if (result.skipReason !== undefined) {
      chunkResult.skipReason = result.skipReason;
    }
    return chunkResult;
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processFile failed', {
      ...formatted,
      id: request.id,
      fileRecordId: request.fileRecordId,
      fileName: request.fileName,
      contentLength,
      strategy,
      phase: 'error',
    });
    const errorResult: ChunkError = {
      type: 'error',
      id: request.id,
      fileRecordId: request.fileRecordId,
      error: formatted.message,
    };
    // Only include stack if it's defined (exactOptionalPropertyTypes compliance)
    if (formatted.stack !== undefined) {
      errorResult.stack = formatted.stack;
    }
    return errorResult;
  }
}

/**
 * Process a batch of files with progress reporting and timeout protection.
 */
async function processBatch(requests: Omit<ChunkRequest, 'type'>[]): Promise<void> {
  if (requests.length === 0) {
    return;
  }

  log('info', 'processBatch start', { total: requests.length });

  const total = requests.length;

  for (const [i, request] of requests.entries()) {
    log('debug', 'processBatch item start', {
      index: i,
      total,
      id: request.id,
      fileName: request.fileName,
    });

    // Use timeout-protected processing
    const result = await processFileWithTimeout(request);
    self.postMessage(result);

    log('debug', 'processBatch item posted', {
      index: i,
      total,
      id: request.id,
      type: result.type,
    });

    // Report batch progress
    self.postMessage({
      type: 'progress',
      id: request.id,
      fileRecordId: request.fileRecordId,
      chunksCreated: result.type === 'result' ? result.chunks.length : 0,
      currentIndex: i,
      totalFiles: total,
    } satisfies ChunkProgress);

    // Yield to prevent blocking (every BATCH_YIELD_INTERVAL files)
    if (i % BATCH_YIELD_INTERVAL === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, YIELD_DELAY_MS));
    }
  }

  log('info', 'processBatch complete', { total });
}

// Handle incoming messages with input validation
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const messageType = (message as { type?: unknown } | null)?.type;

  try {
    log('info', 'onmessage received', { type: messageType });

    // Handle cleanup message (defensive cleanup for edge cases)
    if (messageType === 'cleanup') {
      cleanupGlobalHandlers();
      self.postMessage({ type: 'cleanup-done' });
      return;
    }

    // Validate message structure before processing
    if (isChunkRequest(message)) {
      const result = await processFileWithTimeout(message);
      self.postMessage(result);
    } else if (isChunkBatchRequest(message)) {
      await processBatch(message.requests);
    } else {
      // Invalid or unknown message - log and reject
      log('warn', 'Invalid or unknown message structure', {
        type: messageType,
        hasRequests: Array.isArray((message as { requests?: unknown })?.requests),
      });
      self.postMessage({
        type: 'error',
        id: '__init__',
        fileRecordId: '__init__',
        error: `Invalid message structure: type=${String(messageType)}`,
      } satisfies ChunkError);
    }
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'onmessage handler failed', {
      type: messageType,
      error: formatted,
      phase: 'message-handler',
    });
    self.postMessage({
      type: 'error',
      id: '__init__',
      fileRecordId: '__init__',
      error: formatted.message,
    } satisfies ChunkError);
  }
};

// Bootstrap - signal ready
const bootstrap = async (): Promise<void> => {
  log('info', 'worker bootstrap start');
  try {
    // Pre-warm the chunking modules by doing a tiny chunk
    await chunkContent('// test', { strategy: 'sentence' });
    log('info', 'worker bootstrap modules loaded');
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'worker bootstrap failed', formatted);
    self.postMessage({
      type: 'error',
      id: '__init__',
      fileRecordId: '__init__',
      error: `bootstrap failed: ${formatted.message}`,
    } satisfies ChunkError);
    return;
  }

  self.postMessage({ type: 'ready' });
  log('info', 'worker ready posted');
};

void bootstrap();
