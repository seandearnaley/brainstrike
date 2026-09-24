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

import { runWithTimeout } from '@brainstrike/effect-kit';
import { isChunkBatchRequest, isChunkRequest } from './message-validation';
import { chunkContent, type PortableChunkingResult } from './portable-chunking';
import type {
  ChunkBatchRequest,
  ChunkError,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  WorkerLog,
  WorkerRequest,
} from './shared';

type TokenUtilsLiteModule = typeof import('@brainstrike/tokenization/token-utils-lite');

let tokenUtilsLiteModulePromise: Promise<TokenUtilsLiteModule> | null = null;

async function loadTokenUtilsLiteModule(): Promise<TokenUtilsLiteModule> {
  if (!tokenUtilsLiteModulePromise) {
    tokenUtilsLiteModulePromise = import('@brainstrike/tokenization/token-utils-lite');
  }
  return tokenUtilsLiteModulePromise;
}

async function disposeTokenUtilsLiteModule(): Promise<void> {
  if (!tokenUtilsLiteModulePromise) {
    return;
  }
  const module = await tokenUtilsLiteModulePromise;
  await module.disposeAccurateTokenCountingRuntime();
  tokenUtilsLiteModulePromise = null;
}

// ============================================================================
// Constants
// ============================================================================

/** Number of files between yields during batch processing */
const BATCH_YIELD_INTERVAL = 5;

/** Delay in ms when yielding during batch processing (1ms gives event loop breathing room for GC) */
const YIELD_DELAY_MS = 1;

/** Timeout in ms for processing a single file */
const FILE_PROCESSING_TIMEOUT_MS = 60_000;

/**
 * Maximum content size in bytes (100MB).
 * Protects against OOM from oversized files or corrupted data.
 */
const MAX_CONTENT_SIZE = 100_000_000;

// ============================================================================
// Type Guards for Input Validation
// ============================================================================

/**
 * Validate content size to prevent OOM from oversized files.
 * Returns an error message if content exceeds the limit, null otherwise.
 */
function validateContentSize(content: string, fileRecordId: string): string | null {
  if (content.length > MAX_CONTENT_SIZE) {
    return `Content exceeds maximum size (${content.length} bytes > ${MAX_CONTENT_SIZE} bytes) for file ${fileRecordId}`;
  }
  return null;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log level priority (higher = more severe)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  error: 3,
  info: 1,
  warn: 2,
};

// Static worker log threshold; change this constant locally for verbose diagnosis.
const WORKER_LOG_LEVEL: LogLevel = 'info';
const OVERSIZED_CHUNK_WARNING_PATTERN = /Created a chunk of size \d+,.*longer than specified \d+/;
const SUPPRESSED_WARNING_LOG_INTERVAL = 100;

let restoreChunkWarningFilter: (() => void) | null = null;

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[WORKER_LOG_LEVEL];
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
      ? { data, level, message, type: 'log' }
      : { level, message, type: 'log' };
    self.postMessage(payload);
  } catch {
    // Ignore structured-clone errors; console log still fired below
  }
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  // biome-ignore lint/suspicious/noConsole: worker diagnostics must surface via console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[ChunkingWorker]', message, data ?? '');
  postLog(level, message, data);
}

function shouldSuppressChunkWarning(args: unknown[]): boolean {
  const firstArg = args[0];
  if (typeof firstArg !== 'string') {
    return false;
  }
  return OVERSIZED_CHUNK_WARNING_PATTERN.test(firstArg);
}

function installChunkWarningFilter(): () => void {
  // biome-ignore lint/suspicious/noConsole: Worker must intercept third-party chunking warnings at console boundary.
  if (typeof console === 'undefined' || typeof console.warn !== 'function') {
    return () => {};
  }

  // biome-ignore lint/suspicious/noConsole: Preserve original console.warn for non-filtered warnings.
  const originalWarn = console.warn.bind(console);
  let suppressedCount = 0;

  const filteredWarn: typeof console.warn = ((...args: unknown[]) => {
    if (shouldSuppressChunkWarning(args)) {
      suppressedCount += 1;
      if (suppressedCount === 1 || suppressedCount % SUPPRESSED_WARNING_LOG_INTERVAL === 0) {
        originalWarn('[ChunkingWorker] Suppressed oversized chunk warnings', {
          suppressedCount,
        });
      }
      return;
    }

    originalWarn(...(args as Parameters<typeof console.warn>));
  }) as typeof console.warn;

  try {
    console.warn = filteredWarn;
    return () => {
      console.warn = originalWarn;
    };
  } catch {
    return () => {};
  }
}

// ============================================================================
// Global Error Handlers (with cleanup support)
// ============================================================================

/**
 * Handle global error events in the worker.
 */
function handleGlobalError(event: ErrorEvent): void {
  const payload = {
    colno: event.colno,
    error: event.error ? formatError(event.error) : undefined,
    filename: event.filename,
    lineno: event.lineno,
    message: event.message,
    type: event.type,
  };
  log('error', 'global error event', payload);
  self.postMessage({
    error: `global error: ${payload.message ?? 'unknown'}`,
    fileRecordId: '__init__',
    id: '__init__',
    type: 'error',
  } satisfies ChunkError);
}

/**
 * Handle unhandled promise rejections in the worker.
 */
function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const formatted = formatError(event.reason);
  log('error', 'unhandledrejection', { reason: formatted });
  self.postMessage({
    error: `unhandledrejection: ${formatted.message}`,
    fileRecordId: '__init__',
    id: '__init__',
    type: 'error',
  } satisfies ChunkError);
}

// Register global error handlers
self.addEventListener('error', handleGlobalError);
self.addEventListener('unhandledrejection', handleUnhandledRejection);
restoreChunkWarningFilter = installChunkWarningFilter();

/**
 * Clean up global error handlers (defensive cleanup for edge cases).
 * Called when worker receives a 'cleanup' message.
 */
function cleanupGlobalHandlers(): void {
  self.removeEventListener('error', handleGlobalError);
  self.removeEventListener('unhandledrejection', handleUnhandledRejection);
  restoreChunkWarningFilter?.();
  restoreChunkWarningFilter = null;
  log('info', 'Global error handlers cleaned up');
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
    // The deadline timer is cleared as soon as processFile settles. processFile
    // takes no signal, so work that outlives the deadline still runs to the
    // end; only its result is dropped.
    return await runWithTimeout(() => processFile(request), {
      onTimeout: () => new Error(`Processing timeout after ${timeoutMs}ms: ${context}`),
      timeoutMs,
    });
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processFile timeout or race error', {
      ...formatted,
      fileName: request.fileName,
      fileRecordId: request.fileRecordId,
      id: request.id,
      phase: 'timeout',
    });
    const errorResult: ChunkError = {
      error: formatted.message,
      fileRecordId: request.fileRecordId,
      id: request.id,
      type: 'error',
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
      contentLength,
      fileName: request.fileName,
      fileRecordId: request.fileRecordId,
      id: request.id,
      phase: 'start',
      strategy,
    });

    const result: PortableChunkingResult = await chunkContent(request.content, {
      ...request.options,
      fileName: request.fileName,
      filePath: request.filePath,
    });

    log('debug', 'processFile completed', {
      chunksCreated: result.chunks.length,
      fileRecordId: request.fileRecordId,
      id: request.id,
      phase: 'complete',
      skipped: result.skipped,
      sourceRangeSkippedChunks: result.sourceRangeSkippedChunks,
      strategyUsed: result.strategyUsed,
      totalTokens: result.totalTokens,
    });

    // Report progress for this file
    self.postMessage({
      chunksCreated: result.chunks.length,
      fileRecordId: request.fileRecordId,
      id: request.id,
      type: 'progress',
    } satisfies ChunkProgress);

    const chunkResult: ChunkResult = {
      chunks: result.chunks,
      fileRecordId: request.fileRecordId,
      id: request.id,
      skipped: result.skipped,
      strategyUsed: result.strategyUsed,
      totalTokens: result.totalTokens,
      type: 'result',
    };
    // Only include skipReason if it's defined (exactOptionalPropertyTypes compliance)
    if (result.skipReason !== undefined) {
      chunkResult.skipReason = result.skipReason;
    }
    if (result.sourceRangeSkippedChunks !== undefined) {
      chunkResult.sourceRangeSkippedChunks = result.sourceRangeSkippedChunks;
    }
    if (result.symbols !== undefined && result.symbolRefs !== undefined) {
      chunkResult.symbols = result.symbols;
      chunkResult.symbolRefs = result.symbolRefs;
    }
    return chunkResult;
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'processFile failed', {
      ...formatted,
      contentLength,
      fileName: request.fileName,
      fileRecordId: request.fileRecordId,
      id: request.id,
      phase: 'error',
      strategy,
    });
    const errorResult: ChunkError = {
      error: formatted.message,
      fileRecordId: request.fileRecordId,
      id: request.id,
      type: 'error',
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

  log('debug', 'processBatch start', { total: requests.length });
  const requiresAccurateTokenSizing = requests.some(
    (request) => request.options.tokenTrueSizing === true
  );
  if (requiresAccurateTokenSizing) {
    const tokenUtilsLiteModule = await loadTokenUtilsLiteModule();
    const accurateSupported = await tokenUtilsLiteModule.supportsAccurateTokenCounting();
    if (!accurateSupported) {
      const failureReason = tokenUtilsLiteModule.getAccurateTokenCountingFailureReason();
      const failureSuffix = failureReason ? ` (${failureReason})` : '';
      const firstRequest = requests[0];
      self.postMessage({
        error: `Accurate token counting unavailable: tiktoken encoder failed to initialize${failureSuffix}`,
        fileRecordId: firstRequest?.fileRecordId ?? '__init__',
        id: firstRequest?.id ?? '__init__',
        type: 'error',
      } satisfies ChunkError);
      return;
    }
  }

  const total = requests.length;

  for (const [i, request] of requests.entries()) {
    log('debug', 'processBatch item start', {
      fileName: request.fileName,
      id: request.id,
      index: i,
      total,
    });

    // Use timeout-protected processing
    const result = await processFileWithTimeout(request);

    // CRITICAL: Fail fast on first batch error. The caller already treats any file
    // error as a terminal batch failure, so continuing here only burns CPU and
    // spams duplicate logs/results after the operation is already rejected.
    if (result.type === 'error') {
      self.postMessage(result);
      log('error', 'processBatch aborted after file error', {
        error: result.error,
        fileRecordId: request.fileRecordId,
        id: request.id,
        index: i,
        total,
      });
      return;
    }

    self.postMessage(result);

    log('debug', 'processBatch item posted', {
      id: request.id,
      index: i,
      total,
      type: result.type,
    });

    // Report batch progress
    self.postMessage({
      chunksCreated: result.type === 'result' ? result.chunks.length : 0,
      currentIndex: i,
      fileRecordId: request.fileRecordId,
      id: request.id,
      totalFiles: total,
      type: 'progress',
    } satisfies ChunkProgress);

    // Yield to prevent blocking (every BATCH_YIELD_INTERVAL files)
    if (i % BATCH_YIELD_INTERVAL === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, YIELD_DELAY_MS));
    }
  }

  log('debug', 'processBatch complete', { total });
}

function postChunkError(id: string, fileRecordId: string, error: string, stack?: string): void {
  const payload: ChunkError = {
    error,
    fileRecordId,
    id,
    type: 'error',
  };
  if (stack !== undefined) {
    payload.stack = stack;
  }
  self.postMessage(payload);
}

function postContentSizeValidationError(
  request: Pick<ChunkRequest, 'id' | 'fileRecordId' | 'content'>,
  context: 'single' | 'batch'
): boolean {
  const sizeError = validateContentSize(request.content, request.fileRecordId);
  if (!sizeError) {
    return false;
  }

  log('warn', 'Content size validation failed', {
    contentLength: request.content.length,
    context,
    fileRecordId: request.fileRecordId,
    maxSize: MAX_CONTENT_SIZE,
  });
  postChunkError(request.id, request.fileRecordId, sizeError);
  return true;
}

async function handleChunkRequestMessage(message: ChunkRequest): Promise<void> {
  if (postContentSizeValidationError(message, 'single')) {
    return;
  }

  if (message.options.tokenTrueSizing === true) {
    const tokenUtilsLiteModule = await loadTokenUtilsLiteModule();
    const accurateSupported = await tokenUtilsLiteModule.supportsAccurateTokenCounting();
    if (!accurateSupported) {
      const failureReason = tokenUtilsLiteModule.getAccurateTokenCountingFailureReason();
      const failureSuffix = failureReason ? ` (${failureReason})` : '';
      postChunkError(
        message.id,
        message.fileRecordId,
        `Accurate token counting unavailable: tiktoken encoder failed to initialize${failureSuffix}`
      );
      return;
    }
  }

  const result = await processFileWithTimeout(message);
  self.postMessage(result);
}

async function handleChunkBatchRequestMessage(message: ChunkBatchRequest): Promise<void> {
  const validRequests: Omit<ChunkRequest, 'type'>[] = [];

  for (const request of message.requests) {
    if (!postContentSizeValidationError(request, 'batch')) {
      validRequests.push(request);
    }
  }

  if (validRequests.length > 0) {
    await processBatch(validRequests);
  }
}

function handleInvalidMessage(message: unknown, messageType: unknown): void {
  log('warn', 'Invalid or unknown message structure', {
    hasRequests: Array.isArray((message as { requests?: unknown })?.requests),
    type: messageType,
  });
  postChunkError('__init__', '__init__', `Invalid message structure: type=${String(messageType)}`);
}

// Handle incoming messages with input validation
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const messageType = (message as { type?: unknown } | null)?.type;

  try {
    log('debug', 'onmessage received', { type: messageType });

    // Handle cleanup message (defensive cleanup for edge cases)
    if (messageType === 'cleanup') {
      await disposeTokenUtilsLiteModule();
      cleanupGlobalHandlers();
      self.postMessage({ type: 'cleanup-done' });
      return;
    }

    // Parser-host bridge envelopes are consumed by a SEPARATE
    // self.addEventListener('message', ...) installed by oxc-ipc-adapter.
    // Skip them here — falling through to handleInvalidMessage would
    // post a __init__ error and the renderer would terminate the worker
    // on every parser-host round-trip (regression discovered 2026-05-16).
    if (typeof messageType === 'string' && messageType.startsWith('parser-host:')) {
      return;
    }

    if (messageType === 'init') {
      // Parser-routing config (Phase 8 / P1 #994 fix): the renderer parent
      // tells the worker which parser environment it's running in, since
      // workers have their own globalThis realm and can't read flags the
      // renderer sets on window. Stored on the worker's own globalThis
      // (DedicatedWorkerGlobalScope) so selectAdapter's existing
      // environment.ts reader picks it up without modification.
      const initPayload = message as {
        type: 'init';
        parserEnv?: 'browser' | 'electron-chunking-host';
        parserFlag?: 'auto' | 'babel' | 'oxc';
        treeSitterLanguages?: readonly string[];
      };
      if (initPayload.parserEnv === 'electron-chunking-host') {
        // biome-ignore-start lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        interface ParserEnvGlobal {
          __BRAINSTRIKE_PARSER_ENV__?: 'browser' | 'electron-chunking-host';
        }
        // biome-ignore-end lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        (globalThis as ParserEnvGlobal).__BRAINSTRIKE_PARSER_ENV__ = 'electron-chunking-host';
      }
      if (
        initPayload.parserFlag === 'babel' ||
        initPayload.parserFlag === 'oxc' ||
        initPayload.parserFlag === 'auto'
      ) {
        // biome-ignore-start lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        interface ParserFlagGlobal {
          __BRAINSTRIKE_PARSER_FLAG__?: 'auto' | 'babel' | 'oxc';
        }
        // biome-ignore-end lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        (globalThis as ParserFlagGlobal).__BRAINSTRIKE_PARSER_FLAG__ = initPayload.parserFlag;
      }
      // Tree-sitter languages (Phase 8 of #998). The renderer's bootstrap
      // resolved this from `?treeSitterLanguages=` URL param + default-on
      // policy and validated it strictly (Phase 9 hardening) before
      // assigning to its globalThis. Here we forward it to the worker's
      // separate globalThis realm. The reader
      // (getEnabledTreeSitterLanguages) re-validates strictly on first
      // access — defense in depth in case the worker is initialized from
      // a different code path than the standard renderer bootstrap.
      // Undefined and empty array are meaningfully different:
      // undefined → "renderer didn't say" (rare; reader defaults to []),
      // [] → "renderer explicitly disabled all tree-sitter".
      if (Array.isArray(initPayload.treeSitterLanguages)) {
        // biome-ignore-start lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        interface TreeSitterLanguagesGlobal {
          __BRAINSTRIKE_TREE_SITTER_LANGUAGES__?: readonly string[];
        }
        // biome-ignore-end lint/style/useNamingConvention: shared global key, intentional UPPER_SNAKE_CASE
        (globalThis as TreeSitterLanguagesGlobal).__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ =
          initPayload.treeSitterLanguages;
      }
      self.postMessage({ type: 'ready' });
      return;
    }

    if (isChunkRequest(message)) {
      await handleChunkRequestMessage(message);
      return;
    }

    if (isChunkBatchRequest(message)) {
      await handleChunkBatchRequestMessage(message);
      return;
    }

    handleInvalidMessage(message, messageType);
  } catch (error) {
    const formatted = formatError(error);
    log('error', 'onmessage handler failed', {
      error: formatted,
      phase: 'message-handler',
      type: messageType,
    });
    postChunkError('__init__', '__init__', formatted.message);
  }
};
