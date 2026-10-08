import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DatabaseMain');
export interface ErrorDetails {
  code?: string;
  message: string;
  name?: string;
  stack?: string;
}

function withOptionalErrorCode(message: string, code: string | undefined): ErrorDetails {
  const details: ErrorDetails = { message };
  if (code) {
    details.code = code;
  }
  return details;
}

function stringifyDiagnosticValue(value: unknown): string | null {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (nestedValue instanceof Error) {
        return {
          message: nestedValue.message,
          name: nestedValue.name,
          ...getErrorOwnPropertyPayload(nestedValue),
        };
      }
      if (nestedValue && typeof nestedValue === 'object') {
        if (seen.has(nestedValue)) {
          return '[Circular]';
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    if (serialized && serialized !== '{}') {
      return serialized;
    }
  } catch {
    return null;
  }
  return null;
}

function getErrorOwnPropertyPayload(error: Error): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const property of Object.getOwnPropertyNames(error)) {
    // `cause` is followed by the corruption classifier; serializing it here would copy the
    // wrapped Postgres error's detail/where fields (row data) into user-visible text and logs.
    if (
      property === 'message' ||
      property === 'name' ||
      property === 'stack' ||
      property === 'cause'
    ) {
      continue;
    }
    payload[property] = (error as unknown as Record<string, unknown>)[property];
  }
  return payload;
}

function getPlainObjectErrorDetails(error: object, code: string | undefined): ErrorDetails {
  const serialized = stringifyDiagnosticValue(error);
  if (serialized) {
    return withOptionalErrorCode(serialized, code);
  }
  return withOptionalErrorCode(Object.prototype.toString.call(error), code);
}

function getErrorMessage(error: Error): string {
  const trimmedMessage = error.message.trim();
  const ownPropertyPayload = getErrorOwnPropertyPayload(error);
  const serializedPayload = stringifyDiagnosticValue(ownPropertyPayload);
  if (trimmedMessage && trimmedMessage !== '[object Object]') {
    return serializedPayload ? `${trimmedMessage}; details=${serializedPayload}` : trimmedMessage;
  }
  try {
    const cause = (error as Error & { cause?: unknown }).cause;
    const serializedCause = stringifyDiagnosticValue(cause);
    if (serializedCause) {
      return serializedCause;
    }
  } catch {
    // Fall through to own-property payload below.
  }
  if (serializedPayload) {
    return serializedPayload;
  }
  return trimmedMessage || Object.prototype.toString.call(error);
}

export function getErrorDetails(error: unknown): ErrorDetails {
  const errorCode =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code = typeof errorCode === 'string' ? errorCode : undefined;

  if (error instanceof Error) {
    const details: ErrorDetails = {
      message: getErrorMessage(error),
    };
    if (error.stack) {
      details.stack = error.stack;
    }
    if (error.name) {
      details.name = error.name;
    }
    if (code) {
      details.code = code;
    }
    return details;
  }
  if (error === null || error === undefined) {
    return withOptionalErrorCode('unknown error', code);
  }
  if (typeof error === 'object') {
    return getPlainObjectErrorDetails(error, code);
  }
  return withOptionalErrorCode(String(error), code);
}

export interface PGliteInstanceShape {
  close?: () => Promise<void> | void;
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  syncToFs?: () => Promise<void>;
}

/** The database could not be flushed (`sync`) or shut down (`close`) cleanly. */
export class DatabaseCloseError extends Error {
  readonly stage: 'sync' | 'close';

  constructor(
    stage: 'sync' | 'close',
    cause: unknown,
    message = `Database ${stage} failed: ${getErrorDetails(cause).message}`
  ) {
    super(message, { cause });
    this.name = 'DatabaseCloseError';
    this.stage = stage;
  }
}

export async function syncDatabaseToFs(
  instance: PGliteInstanceShape,
  context: string
): Promise<void> {
  if (typeof instance.syncToFs !== 'function') {
    return;
  }

  try {
    await instance.syncToFs();
  } catch (error) {
    logger.error('Failed to sync database files to disk', {
      context,
      error: getErrorDetails(error),
    });
    throw error;
  }
}

export async function closeDatabaseInstance(
  instance: PGliteInstanceShape,
  context: string
): Promise<void> {
  if (typeof instance.close !== 'function') {
    return;
  }

  try {
    await instance.close();
  } catch (error) {
    logger.error('Failed to close database instance cleanly', {
      context,
      error: getErrorDetails(error),
    });
    throw error;
  }
}

const WASM_ABORT_ERROR_PATTERNS = [
  'aborted(). build with -sassertions for more info.',
  'aborted()',
  'runtimeerror: unreachable',
  'wasm trap',
] as const;

export function isWasmAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return WASM_ABORT_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern));
}
