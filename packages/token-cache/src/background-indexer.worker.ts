/**
 * Background Token Indexer Worker
 *
 * A dedicated Web Worker that handles the complete token indexing pipeline:
 * 1. Receives FileSystemFileHandle via postMessage
 * 2. Reads file content off the main thread
 * 3. Hashes content with xxHash64
 * 4. Counts tokens (accurate or heuristic mode)
 * 5. Posts results back to main thread
 *
 * This keeps ALL heavy computation off the main thread, ensuring smooth UI.
 */

/// <reference lib="webworker" />

import type { TokenCountingMode } from './types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type WorkerLog = {
  type: 'log';
  level: LogLevel;
  message: string;
  data?: Record<string, unknown> | undefined;
};

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
  // biome-ignore lint/suspicious/noConsole: worker diagnostics must surface
  console.error('[BackgroundTokenIndexerWorker]', message, data ?? '');
  postLog(level, message, data);
}

log('info', 'worker script evaluated');

/**
 * Electron-style handle with path property
 */
export type ElectronFileHandle = {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
};

// Message types for worker communication
export type IndexerRequest = {
  type: 'index';
  id: string;
  compositeKey: string;
  folderId: string;
  filePath: string;
  /** Web FileSystemFileHandle for File System Access API */
  fileHandle?: FileSystemFileHandle;
  /** Electron-style handle with path for direct file access */
  electronHandle?: ElectronFileHandle;
  cachedHash: string | undefined; // If provided, skip if hash matches
  mode: TokenCountingMode;
};

export type IndexerBatchRequest = {
  type: 'index-batch';
  requests: Omit<IndexerRequest, 'type'>[];
};

export type IndexerResult = {
  type: 'result';
  id: string;
  compositeKey: string;
  folderId: string;
  filePath: string;
  tokenCount: number;
  contentHash: string;
  mode: TokenCountingMode;
  fileSize: number;
  skipped: boolean; // True if hash matched and counting was skipped
};

export type IndexerProgress = {
  type: 'progress';
  completed: number;
  total: number;
  currentId: string;
};

export type IndexerError = {
  type: 'error';
  id: string;
  compositeKey: string;
  error: string;
};

export type WorkerMessage = IndexerRequest | IndexerBatchRequest;
export type WorkerResponse = IndexerResult | IndexerProgress | IndexerError | WorkerLog;

// Lazy-loaded modules
type XXHashModule = {
  h64: (input: string) => bigint;
};

let hasherInstance: XXHashModule | null = null;
let tokenUtilsPromise: Promise<{
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
    log('debug', 'initHasher reuse existing instance');
    return hasherInstance;
  }

  log('info', 'initHasher start (loading xxhash-wasm)');
  const xxhashModule = await import('xxhash-wasm');
  const xxhashFn = typeof xxhashModule.default === 'function' ? xxhashModule.default : xxhashModule;
  hasherInstance = (await (xxhashFn as () => Promise<XXHashModule>)()) as XXHashModule;
  log('info', 'initHasher complete');
  return hasherInstance;
}

/**
 * Lazy load token counting utilities
 */
async function getTokenUtils(): Promise<{
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> {
  if (!tokenUtilsPromise) {
    log('info', 'getTokenUtils start (import token-utils-lite)');
    tokenUtilsPromise = import('./token-utils-lite')
      .then((mod) => ({
        countTokensAccurate: mod.countTokensAccurate,
        countTokensHeuristic: mod.countTokensHeuristic,
      }))
      .then((utils) => {
        log('info', 'getTokenUtils resolved');
        return utils;
      })
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
 * Read file content - supports both Web FileSystemFileHandle and Electron path-based access
 */
async function readFileContent(
  request: Omit<IndexerRequest, 'type'>
): Promise<{ content: string; fileSize: number }> {
  // Web File System Access API
  if (request.fileHandle) {
    const file = await request.fileHandle.getFile();
    return { content: await file.text(), fileSize: file.size };
  }

  // Electron path-based access via fetch with file:// protocol
  if (request.electronHandle?.path) {
    const fileUrl = `file://${request.electronHandle.path}`;
    log('debug', 'readFileContent via fetch', { fileUrl });
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    // Estimate file size from content length (may differ from actual due to encoding)
    const fileSize = new Blob([content]).size;
    return { content, fileSize };
  }

  throw new Error('No valid file handle provided - need either fileHandle or electronHandle');
}

/**
 * Process a single file: read, hash, count tokens
 */
async function processFile(
  request: Omit<IndexerRequest, 'type'>,
  hasher: XXHashModule,
  utils: Awaited<ReturnType<typeof getTokenUtils>>
): Promise<IndexerResult | IndexerError> {
  try {
    log('info', 'processFile start', {
      id: request.id,
      compositeKey: request.compositeKey,
      filePath: request.filePath,
      mode: request.mode,
      hasCachedHash: Boolean(request.cachedHash),
      hasFileHandle: Boolean(request.fileHandle),
      hasElectronHandle: Boolean(request.electronHandle),
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
      log('info', 'processFile cache hit; skipping count', { id: request.id });
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
      };
    }

    // Count tokens
    const tokenCount =
      request.mode === 'accurate'
        ? await utils.countTokensAccurate(content)
        : utils.countTokensHeuristic(content);
    log('info', 'processFile token counted', { tokenCount, mode: request.mode });

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

/**
 * Process a batch of files with progress reporting
 */
async function processBatch(requests: Omit<IndexerRequest, 'type'>[]): Promise<void> {
  if (requests.length === 0) {
    return;
  }

  log('info', 'processBatch start', { total: requests.length });

  try {
    // Pre-initialize to avoid repeated async overhead
    const [hasher, utils] = await Promise.all([initHasher(), getTokenUtils()]);

    const total = requests.length;

    for (const [i, request] of requests.entries()) {
      log('debug', 'processBatch item start', { index: i, total, id: request.id });
      const result = await processFile(request, hasher, utils);
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
    log('info', 'onmessage received', { type: (message as { type?: unknown }).type });
    if (message.type === 'index') {
      const [hasher, utils] = await Promise.all([initHasher(), getTokenUtils()]);
      const result = await processFile(message, hasher, utils);
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
  log('info', 'worker bootstrap start');
  try {
    await Promise.all([initHasher(), getTokenUtils()]);
    log('info', 'worker bootstrap modules loaded');
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
  log('info', 'worker ready posted');
};

void bootstrap();
