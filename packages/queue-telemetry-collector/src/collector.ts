import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { QueueTelemetryEvent, QueueTelemetryRuntime } from '@brainstrike/queue';
import { createLogger } from '@brainstrike/utils';

const DEFAULT_COLLECTOR_PATH = '/queue-telemetry';
const DEFAULT_MAX_BODY_BYTES = 256_000;
const DEFAULT_MAX_STORED_BATCHES = 100;
const WAIT_FOR_BATCH_TIMEOUT_MS = 5000;

export interface QueueTelemetryBatch {
  readonly events: readonly QueueTelemetryEvent[];
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly receivedAt: Date;
  readonly runtime: QueueTelemetryRuntime;
  readonly sentAt: Date;
}

export interface QueueTelemetryCollectorOptions {
  readonly apiKey?: string;
  readonly host?: string;
  readonly maxBodyBytes?: number;
  readonly maxStoredBatches?: number;
  readonly onBatch?: (batch: QueueTelemetryBatch) => Promise<void> | void;
  readonly path?: string;
  readonly port?: number;
}

export interface QueueTelemetryCollector {
  clearBatches(): void;
  getEndpoint(): string | null;
  isRunning(): boolean;
  listBatches(): readonly QueueTelemetryBatch[];
  nextBatch(options?: { readonly timeoutMs?: number }): Promise<QueueTelemetryBatch>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type BatchListener = (batch: QueueTelemetryBatch) => void;

class PayloadTooLargeError extends Error {
  constructor() {
    super('Payload too large');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTelemetryRuntime(value: unknown): value is QueueTelemetryRuntime {
  return value === 'browser' || value === 'electron-renderer' || value === 'electron-main';
}

function isTelemetryEvent(value: unknown): value is QueueTelemetryEvent {
  if (!isPlainObject(value)) {
    return false;
  }
  const { timestamp, adapter, event, taskId } = value;
  return (
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    typeof adapter === 'string' &&
    adapter.length > 0 &&
    (event === 'enqueue' || event === 'complete' || event === 'error') &&
    typeof taskId === 'string' &&
    taskId.length > 0
  );
}

function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    request.on('data', (chunk: Buffer | string) => {
      const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      receivedBytes += bufferChunk.length;
      if (receivedBytes > maxBodyBytes) {
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(bufferChunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: message }));
}

function normalisePath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path.replace(/\/+$/, '') || '/';
}

function headerValue(header: string | string[] | undefined): string | null {
  if (typeof header === 'undefined') {
    return null;
  }
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }
  return header;
}

function timingSafeDigestEqual(providedDigest: Buffer, expectedDigest: Buffer): boolean {
  const lengthsMatch = providedDigest.length === expectedDigest.length;
  // SHA-256 HMAC digests are fixed-length today; this keeps future algorithm changes from adding a length-oracle branch.
  const comparableDigest = lengthsMatch ? providedDigest : Buffer.alloc(expectedDigest.length);
  return timingSafeEqual(comparableDigest, expectedDigest) && lengthsMatch;
}

export function createQueueTelemetryCollector(
  options: QueueTelemetryCollectorOptions = {}
): QueueTelemetryCollector {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const path = normalisePath(options.path ?? DEFAULT_COLLECTOR_PATH);
  const apiKey = options.apiKey ?? null;
  const apiKeyHmac = apiKey
    ? createHmac('sha256', Buffer.from(apiKey, 'utf8')).update(Buffer.from(apiKey, 'utf8')).digest()
    : null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxStoredBatches = options.maxStoredBatches ?? DEFAULT_MAX_STORED_BATCHES;
  const onBatchCallback = options.onBatch ?? null;
  const logger = createLogger('QueueTelemetryCollector');

  let server: ReturnType<typeof createServer> | null = null;
  let addressInfo: AddressInfo | null = null;
  const batches: QueueTelemetryBatch[] = [];
  const listeners = new Set<BatchListener>();

  const notifyBatch = (batch: QueueTelemetryBatch) => {
    batches.push(batch);
    if (batches.length > maxStoredBatches) {
      batches.splice(0, batches.length - maxStoredBatches);
    }
    const listener = listeners.values().next().value as BatchListener | undefined;
    if (listener) {
      listeners.delete(listener);
      listener(batch);
    }
    if (onBatchCallback) {
      Promise.resolve(onBatchCallback(batch)).catch((error) => {
        logger.warn('Telemetry collector onBatch handler failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const resolveRequestPath = (requestUrl: string | undefined): string | null => {
    if (!requestUrl) {
      return null;
    }
    return new URL(requestUrl, `http://${host}`).pathname.replace(/\/+$/, '') || '/';
  };

  interface ValidationError {
    message: string;
    status: number;
  }

  const isValidationError = (value: unknown): value is ValidationError =>
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'message' in value &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { message?: unknown }).message === 'string';

  const validateMethod = (method: string | undefined): ValidationError | null => {
    if (method === 'POST') {
      return null;
    }
    return { status: 405, message: 'Method Not Allowed' };
  };

  const validateApiKey = (request: IncomingMessage): ValidationError | null => {
    if (!(apiKey && apiKeyHmac)) {
      return null;
    }
    const providedKey = headerValue(request.headers['x-api-key']);
    if (!providedKey) {
      return { status: 401, message: 'Unauthorized' };
    }

    // HMAC the provided value to normalize length and prevent leaking key length via timing
    const providedHmac = createHmac('sha256', Buffer.from(apiKey, 'utf8'))
      .update(Buffer.from(providedKey, 'utf8'))
      .digest();

    if (!timingSafeDigestEqual(providedHmac, apiKeyHmac)) {
      return { status: 401, message: 'Unauthorized' };
    }

    return null;
  };

  const decodePayloadBuffer = (buffer: Buffer): Record<string, unknown> | ValidationError => {
    let payload: unknown;
    try {
      payload = JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      return { status: 400, message: 'Invalid JSON payload' };
    }
    if (!isPlainObject(payload)) {
      return { status: 400, message: 'Payload must be an object' };
    }
    return payload;
  };

  const extractRuntime = (value: unknown): QueueTelemetryRuntime | ValidationError => {
    if (!isTelemetryRuntime(value)) {
      return { status: 400, message: 'Invalid runtime' };
    }
    return value;
  };

  const extractSentAt = (value: unknown): Date | ValidationError => {
    if (typeof value !== 'string') {
      return { status: 400, message: 'Invalid sentAt timestamp' };
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { status: 400, message: 'Invalid sentAt timestamp' };
    }
    return parsed;
  };

  const extractEvents = (value: unknown): readonly QueueTelemetryEvent[] | ValidationError => {
    if (!Array.isArray(value) || value.some((event) => !isTelemetryEvent(event))) {
      return { status: 400, message: 'Invalid telemetry events' };
    }
    return value as QueueTelemetryEvent[];
  };

  const normalizeMetadata = (value: unknown): Record<string, unknown> | null => {
    if (value === null || typeof value === 'undefined') {
      return null;
    }
    if (isPlainObject(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  };

  const parseTelemetryPayload = async (
    request: IncomingMessage
  ): Promise<QueueTelemetryBatch | ValidationError> => {
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return { status: 413, message: error.message };
      }
      throw error;
    }
    const decoded = decodePayloadBuffer(bodyBuffer);
    if (isValidationError(decoded)) {
      return decoded;
    }

    const runtime = extractRuntime(decoded['runtime'] ?? null);
    if (isValidationError(runtime)) {
      return runtime;
    }

    const sentAt = extractSentAt(decoded['sentAt'] ?? null);
    if (isValidationError(sentAt)) {
      return sentAt;
    }

    const events = extractEvents(decoded['events'] ?? null);
    if (isValidationError(events)) {
      return events;
    }

    const metadata = normalizeMetadata(decoded['metadata'] ?? null);

    return {
      runtime,
      sentAt,
      receivedAt: new Date(),
      events,
      metadata,
    };
  };

  const processTelemetryRequest = async (
    request: IncomingMessage
  ): Promise<QueueTelemetryBatch | ValidationError> => {
    const requestPath = resolveRequestPath(request.url);
    if (!requestPath) {
      return { status: 400, message: 'Request URL missing' };
    }
    if (requestPath !== path) {
      return { status: 404, message: 'Not Found' };
    }

    const methodValidation = validateMethod(request.method);
    if (methodValidation) {
      return methodValidation;
    }

    const apiValidation = validateApiKey(request);
    if (apiValidation) {
      return apiValidation;
    }

    return parseTelemetryPayload(request);
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const result = await processTelemetryRequest(request);
      if (isValidationError(result)) {
        if (result.status === 405) {
          response.setHeader('allow', 'POST');
        }
        sendError(response, result.status, result.message);
        return;
      }

      notifyBatch(result);

      response.statusCode = 204;
      response.end();
    } catch (error) {
      logger.error('Failed to process telemetry request', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.writableEnded) {
        sendError(response, 500, 'Internal Server Error');
      }
    }
  };

  const waitForBatch = (timeoutMs: number): Promise<QueueTelemetryBatch> => {
    if (batches.length > 0) {
      const [latestBatch] = batches.slice(-1);
      if (latestBatch) {
        return Promise.resolve(latestBatch);
      }
    }
    return new Promise<QueueTelemetryBatch>((resolve, reject) => {
      let settled = false;
      const listener: BatchListener = (batch) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(batch);
      };

      listeners.add(listener);

      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        listeners.delete(listener);
        reject(new Error('Timed out waiting for telemetry batch'));
      }, timeoutMs);
    });
  };

  return {
    async start() {
      if (server) {
        return;
      }
      server = createServer(handleRequest);
      await new Promise<void>((resolve, reject) => {
        server?.once('error', (error) => {
          reject(error);
        });
        server?.listen(port, host, () => {
          const addr = server?.address();
          if (!addr || typeof addr === 'string') {
            reject(new Error('Failed to determine collector address'));
            return;
          }
          addressInfo = addr;
          logger.info('Queue telemetry collector listening', {
            address: addr.address,
            port: addr.port,
            path,
          });
          resolve();
        });
      });
    },
    async stop() {
      if (!server) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
      addressInfo = null;
      listeners.clear();
    },
    isRunning() {
      return Boolean(server?.listening);
    },
    getEndpoint() {
      if (!addressInfo) {
        return null;
      }
      const address = addressInfo.address === '::' ? '127.0.0.1' : addressInfo.address;
      return `http://${address}:${addressInfo.port}${path}`;
    },
    listBatches() {
      return [...batches];
    },
    clearBatches() {
      batches.splice(0, batches.length);
    },
    nextBatch(options) {
      const timeoutMs = options?.timeoutMs ?? WAIT_FOR_BATCH_TIMEOUT_MS;
      return waitForBatch(timeoutMs);
    },
  };
}
