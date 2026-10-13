import type {
  AssistantRunEventJson,
  AssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import { LOCAL_TOOL_CALL_ARGUMENTS_INVALID } from './providers/local/local-tool-call-validation';

export const PROVIDER_RUN_ERROR_METADATA_KEY = 'runError';
export const PROVIDER_RUN_ERROR_FALLBACK_CODE = 'mastra_agent_stream_provider_error';
/**
 * Fallback classification for errors carrying no provider response evidence
 * (no httpStatus, no providerRequestId, no responseHeaders): local failures —
 * e.g. a renderer/runtime TypeError inside the stream chain — must not wear
 * the provider-error label they wore during the 2026-08-03 grepSearch
 * projection incident.
 */
export const LOCAL_RUN_ERROR_FALLBACK_CODE = 'mastra_agent_stream_local_error';

/**
 * True for run-error codes whose fault never crossed to a provider: the
 * evidence-free local fallback and the local model's malformed-tool-arguments
 * fault. Log fingerprints and breadcrumb messages branch on this so local
 * faults never wear the provider label.
 */
export function isLocalRunErrorClassification(code: string): boolean {
  return code === LOCAL_RUN_ERROR_FALLBACK_CODE || code === LOCAL_TOOL_CALL_ARGUMENTS_INVALID;
}
export const MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS = 600;
export const MAX_PROVIDER_RUN_ERROR_CAUSES = 4;
export const MAX_PROVIDER_RUN_ERROR_CAUSE_CHARS = 300;
export const MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS = 256;
export const MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS = 512;

const TRUNCATION_MARKER = '… [truncated]';

const STABLE_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
  LOCAL_RUN_ERROR_FALLBACK_CODE,
  LOCAL_TOOL_CALL_ARGUMENTS_INVALID,
  'context_length_exceeded',
  'max_tokens_exceeded',
  'token_limit_exceeded',
] as const);

const CONTEXT_OVERFLOW_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'max_tokens_exceeded',
  'token_limit_exceeded',
]);

export function isContextOverflowProviderErrorCode(code: string): boolean {
  return CONTEXT_OVERFLOW_PROVIDER_ERROR_CODES.has(code);
}

export const PROVIDER_RUN_ERROR_RESPONSE_HEADER_NAMES = [
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-request-id',
  'openai-request-id',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'request-id',
  'retry-after',
  'x-amz-request-id',
  'x-amzn-requestid',
  'x-client-request-id',
  'x-goog-request-id',
  'x-ms-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-request-id',
] as const;

export type ProviderRunErrorResponseHeaderName =
  (typeof PROVIDER_RUN_ERROR_RESPONSE_HEADER_NAMES)[number];

export type ProviderRunErrorResponseHeaders = Partial<
  Record<ProviderRunErrorResponseHeaderName, string>
>;

export interface ProviderRunError {
  readonly causeChain?: readonly string[];
  readonly code: string;
  readonly httpStatus?: number;
  readonly message?: string;
  readonly providerRequestId?: string;
  readonly responseHeaders?: ProviderRunErrorResponseHeaders;
}

const PROVIDER_RUN_ERROR_KEYS = new Set([
  'causeChain',
  'code',
  'httpStatus',
  'message',
  'providerRequestId',
  'responseHeaders',
]);
const RESPONSE_HEADER_NAME_SET = new Set<string>(PROVIDER_RUN_ERROR_RESPONSE_HEADER_NAMES);
const REQUEST_ID_HEADER_NAMES: readonly ProviderRunErrorResponseHeaderName[] = [
  'x-request-id',
  'request-id',
  'openai-request-id',
  'anthropic-request-id',
  'x-goog-request-id',
  'x-amz-request-id',
  'x-amzn-requestid',
  'x-ms-request-id',
  'x-client-request-id',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readProperty(record: Record<string, unknown> | undefined, key: string): unknown {
  if (!record) {
    return;
  }
  try {
    return record[key];
  } catch {
    return;
  }
}

function truncateWithMarker(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, maximumLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function readBoundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  return truncateWithMarker(trimmed, maximumLength);
}

function readStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function readNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  return readRecord(readProperty(record, key));
}

function walkErrorRecords(value: unknown): readonly Record<string, unknown>[] {
  const root = readRecord(value);
  if (!root) {
    return [];
  }

  const records: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current: Record<string, unknown> | undefined = root;
  while (current && records.length <= MAX_PROVIDER_RUN_ERROR_CAUSES) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    records.push(current);
    current = readRecord(readProperty(current, 'cause'));
  }
  return records;
}

function readMessage(
  value: unknown,
  records: readonly Record<string, unknown>[]
): string | undefined {
  if (typeof value === 'string') {
    return readBoundedString(value, MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS);
  }
  for (const record of records) {
    const error = readNestedRecord(record, 'error');
    const dataError = readNestedRecord(readNestedRecord(record, 'data'), 'error');
    const candidates = [
      readProperty(record, 'message'),
      readProperty(error, 'message'),
      readProperty(dataError, 'message'),
    ];
    for (const candidate of candidates) {
      const message = readBoundedString(candidate, MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS);
      if (message) {
        return message;
      }
    }
  }
  return;
}

function formatCause(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return readBoundedString(value, MAX_PROVIDER_RUN_ERROR_CAUSE_CHARS);
  }
  const record = readRecord(value);
  if (!record) {
    return;
  }
  const message = readBoundedString(readProperty(record, 'message'), Number.MAX_SAFE_INTEGER);
  const name = readBoundedString(readProperty(record, 'name'), 80);
  if (!(message || name)) {
    return;
  }
  return truncateWithMarker(
    name && message && name !== message ? `${name}: ${message}` : (message ?? name ?? ''),
    MAX_PROVIDER_RUN_ERROR_CAUSE_CHARS
  );
}

function readCauseChain(value: unknown): readonly string[] | undefined {
  const root = readRecord(value);
  if (!root) {
    return;
  }
  const causeChain: string[] = [];
  const seen = new Set<object>([root]);
  let cause = readProperty(root, 'cause');
  while (
    cause !== undefined &&
    cause !== null &&
    causeChain.length < MAX_PROVIDER_RUN_ERROR_CAUSES
  ) {
    if (typeof cause === 'object') {
      if (seen.has(cause)) {
        break;
      }
      seen.add(cause);
    }
    const formatted = formatCause(cause);
    if (formatted) {
      causeChain.push(formatted);
    }
    const causeRecord = readRecord(cause);
    if (!causeRecord) {
      break;
    }
    cause = readProperty(causeRecord, 'cause');
  }
  return causeChain.length > 0 ? causeChain : undefined;
}

function readStableCodeCandidate(value: unknown): string | undefined {
  const code = readBoundedString(value, 120);
  return code && STABLE_PROVIDER_ERROR_CODES.has(code) ? code : undefined;
}

function readStableProviderCode(records: readonly Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    const data = readNestedRecord(record, 'data');
    const dataError = readNestedRecord(data, 'error');
    const error = readNestedRecord(record, 'error');
    const metadata = readNestedRecord(record, 'metadata');
    const errorMetadata = readNestedRecord(error, 'metadata');
    const dataErrorMetadata = readNestedRecord(dataError, 'metadata');
    const candidates = [
      readProperty(record, 'code'),
      readProperty(record, 'error_type'),
      readProperty(metadata, 'error_type'),
      readProperty(error, 'code'),
      readProperty(error, 'error_type'),
      readProperty(errorMetadata, 'error_type'),
      readProperty(dataError, 'code'),
      readProperty(dataError, 'error_type'),
      readProperty(dataErrorMetadata, 'error_type'),
    ];
    for (const candidate of candidates) {
      const stableCode = readStableCodeCandidate(candidate);
      if (stableCode) {
        return stableCode;
      }
    }
  }
  return;
}

// AI SDK error classes whose existence proves the call crossed to a provider:
// APICallError is only constructed around a provider HTTP call, and RetryError
// only wraps exhausted APICallError attempts. A local runtime fault (e.g. a
// renderer TypeError) never wears these names.
const API_CALL_ERROR_NAMES: ReadonlySet<string> = new Set(['AI_APICallError', 'AI_RetryError']);

function isApiCallErrorMarker(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  const name = readProperty(record, 'name');
  if (typeof name === 'string' && API_CALL_ERROR_NAMES.has(name)) {
    return true;
  }
  // APICallError always carries url + requestBodyValues, even when the name
  // was lost to serialization across a boundary.
  return (
    typeof readProperty(record, 'url') === 'string' &&
    readProperty(record, 'requestBodyValues') !== undefined
  );
}

function hasApiCallErrorMarker(records: readonly Record<string, unknown>[]): boolean {
  return records.some((record) =>
    [
      record,
      readNestedRecord(record, 'error'),
      readNestedRecord(readNestedRecord(record, 'data'), 'error'),
    ].some(isApiCallErrorMarker)
  );
}

function readHttpStatus(records: readonly Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const response = readNestedRecord(record, 'response');
    const error = readNestedRecord(record, 'error');
    const dataError = readNestedRecord(readNestedRecord(record, 'data'), 'error');
    const candidates = [
      readProperty(record, 'statusCode'),
      readProperty(record, 'status'),
      readProperty(record, 'code'),
      readProperty(error, 'statusCode'),
      readProperty(error, 'status'),
      readProperty(error, 'code'),
      readProperty(response, 'statusCode'),
      readProperty(response, 'status'),
      readProperty(dataError, 'code'),
    ];
    for (const candidate of candidates) {
      const status = readStatus(candidate);
      if (status !== undefined) {
        return status;
      }
    }
  }
  return;
}

function readHeaderEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (value instanceof Headers) {
    return [...value.entries()];
  }
  const record = readRecord(value);
  return record ? Object.entries(record) : [];
}

function readHeaderCollections(
  record: Record<string, unknown>
): readonly (readonly (readonly [string, unknown])[])[] {
  const response = readNestedRecord(record, 'response');
  return [
    readHeaderEntries(readProperty(record, 'responseHeaders')),
    readHeaderEntries(readProperty(response, 'headers')),
  ].filter((entries) => entries.length > 0);
}

function readResponseHeaders(
  records: readonly Record<string, unknown>[]
): ProviderRunErrorResponseHeaders | undefined {
  const responseHeaders: ProviderRunErrorResponseHeaders = {};
  for (const record of records) {
    for (const entries of readHeaderCollections(record)) {
      for (const [rawName, rawValue] of entries) {
        const name = rawName.toLowerCase();
        if (!RESPONSE_HEADER_NAME_SET.has(name)) {
          continue;
        }
        if (responseHeaders[name as ProviderRunErrorResponseHeaderName] !== undefined) {
          continue;
        }
        const value = readBoundedString(rawValue, MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS);
        if (value) {
          responseHeaders[name as ProviderRunErrorResponseHeaderName] = value;
        }
      }
    }
  }
  return Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined;
}

function readProviderRequestId(
  records: readonly Record<string, unknown>[],
  responseHeaders: ProviderRunErrorResponseHeaders | undefined
): string | undefined {
  for (const record of records) {
    const candidates = [
      readProperty(record, 'requestId'),
      readProperty(record, 'requestID'),
      readProperty(record, 'request_id'),
    ];
    for (const candidate of candidates) {
      const requestId = readBoundedString(candidate, MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS);
      if (requestId) {
        return requestId;
      }
    }
  }
  for (const name of REQUEST_ID_HEADER_NAMES) {
    const requestId = readBoundedString(
      responseHeaders?.[name],
      MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS
    );
    if (requestId) {
      return requestId;
    }
  }
  return;
}

export function extractProviderRunError(value: unknown): ProviderRunError {
  const records = walkErrorRecords(value);
  const httpStatus = readHttpStatus(records);
  const responseHeaders = readResponseHeaders(records);
  const providerRequestId = readProviderRequestId(records, responseHeaders);
  // Without a stable typed code, classify by provider evidence: a failure with
  // no api-call error marker, no httpStatus, no providerRequestId, and no
  // responseHeaders never crossed to a provider, so it gets the local fallback
  // code instead of the provider one.
  const hasProviderEvidence =
    httpStatus !== undefined ||
    providerRequestId !== undefined ||
    responseHeaders !== undefined ||
    hasApiCallErrorMarker(records);
  const fallbackCode = hasProviderEvidence
    ? PROVIDER_RUN_ERROR_FALLBACK_CODE
    : LOCAL_RUN_ERROR_FALLBACK_CODE;
  const code = readStableProviderCode(records) ?? fallbackCode;
  // runError is durable renderer-visible metadata, including expanded activity.
  // Local exception prose belongs only to the original private logger cause.
  if (isLocalRunErrorClassification(code)) {
    return { code };
  }
  const message = readMessage(value, records);
  const causeChain = readCauseChain(value);
  return {
    code,
    ...(message ? { message } : {}),
    ...(causeChain ? { causeChain } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
  };
}

export function providerRunErrorToEventMetadata(
  runError: ProviderRunError
): AssistantRunEventMetadata {
  return {
    [PROVIDER_RUN_ERROR_METADATA_KEY]: runError as unknown as AssistantRunEventJson,
  };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => keys.has(key));
}

function isValidBoundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value
  );
}

function isProviderRunErrorResponseHeaders(
  value: unknown
): value is ProviderRunErrorResponseHeaders {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    return false;
  }
  return Object.entries(value).every(
    ([name, headerValue]) =>
      RESPONSE_HEADER_NAME_SET.has(name) &&
      isValidBoundedString(headerValue, MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS)
  );
}

export function isProviderRunError(value: unknown): value is ProviderRunError {
  if (!(isPlainRecord(value) && hasOnlyKeys(value, PROVIDER_RUN_ERROR_KEYS))) {
    return false;
  }
  if (
    !(isValidBoundedString(value['code'], 120) && STABLE_PROVIDER_ERROR_CODES.has(value['code']))
  ) {
    return false;
  }
  if (
    value['message'] !== undefined &&
    !isValidBoundedString(value['message'], MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS)
  ) {
    return false;
  }
  if (
    value['causeChain'] !== undefined &&
    (!Array.isArray(value['causeChain']) ||
      value['causeChain'].length === 0 ||
      value['causeChain'].length > MAX_PROVIDER_RUN_ERROR_CAUSES ||
      !value['causeChain'].every((entry) =>
        isValidBoundedString(entry, MAX_PROVIDER_RUN_ERROR_CAUSE_CHARS)
      ))
  ) {
    return false;
  }
  if (value['httpStatus'] !== undefined && readStatus(value['httpStatus']) === undefined) {
    return false;
  }
  if (
    value['providerRequestId'] !== undefined &&
    !isValidBoundedString(value['providerRequestId'], MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS)
  ) {
    return false;
  }
  return (
    value['responseHeaders'] === undefined ||
    isProviderRunErrorResponseHeaders(value['responseHeaders'])
  );
}

export function readProviderRunError(metadata: unknown): ProviderRunError | undefined {
  if (!isPlainRecord(metadata)) {
    return;
  }
  const runError = metadata[PROVIDER_RUN_ERROR_METADATA_KEY];
  return isProviderRunError(runError) ? runError : undefined;
}
