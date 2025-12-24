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
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  WorkerLog,
  WorkerRequest,
} from './shared';

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

// Global error handlers
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
    fileRecordId: '__init__',
    error: `global error: ${payload.message ?? 'unknown'}`,
  } satisfies ChunkError);
});

self.addEventListener('unhandledrejection', (event) => {
  const formatted = formatError(event.reason);
  log('error', 'unhandledrejection', { reason: formatted });
  self.postMessage({
    type: 'error',
    id: '__init__',
    fileRecordId: '__init__',
    error: `unhandledrejection: ${formatted.message}`,
  } satisfies ChunkError);
});

/**
 * Process a single file: chunk content
 */
async function processFile(request: Omit<ChunkRequest, 'type'>): Promise<ChunkResult | ChunkError> {
  try {
    log('debug', 'processFile start', {
      id: request.id,
      fileRecordId: request.fileRecordId,
      fileName: request.fileName,
      contentLength: request.content?.length ?? 0,
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
 * Process a batch of files with progress reporting
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

    const result = await processFile(request);
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

    // Yield to prevent blocking (every 5 files)
    if (i % 5 === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  log('info', 'processBatch complete', { total });
}

// Handle incoming messages
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    log('info', 'onmessage received', { type: (message as { type?: unknown }).type });

    if (message.type === 'chunk') {
      const result = await processFile(message);
      self.postMessage(result);
    } else if (message.type === 'chunk-batch') {
      await processBatch((message as ChunkBatchRequest).requests);
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
