import {
  CallToolResultSchema,
  EmptyResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';
import * as McpAppsSchemas from '@modelcontextprotocol/ext-apps';
import { correlationKey } from './internal.js';
import { parseMcpAppJsonRecord, parseMcpAppJsonValue, parseMcpAppRequestId } from './messages.js';
import {
  expectEncodedSize,
  expectExactKeys,
  expectRecord,
  MCP_APP_MAX_MESSAGE_BYTES,
  type UnknownRecord,
} from './validation.js';

export type McpAppResponse =
  | Readonly<{ id: number | string; jsonrpc: '2.0'; result: Readonly<UnknownRecord> }>
  | Readonly<{
      error: Readonly<{ code: number; data?: unknown; message: string }>;
      /**
       * JSON-RPC 2.0 requires `null` when the responder could not read the
       * request id (parse error, invalid request). Such an error is preserved
       * for diagnostics but can never settle a pending request.
       */
      id: number | string | null;
      jsonrpc: '2.0';
    }>;

type McpAppRpcError = Readonly<{ code: number; data?: unknown; message: string }>;

export type McpAppRequestMethod =
  | 'ping'
  | 'resources/read'
  | 'tools/call'
  | 'ui/initialize'
  | 'ui/message'
  | 'ui/open-link'
  | 'ui/request-display-mode'
  | 'ui/resource-teardown'
  | 'ui/update-model-context';

interface CanonicalResultSchema {
  safeParse(value: unknown): { readonly success: boolean };
}

function requireMcpAppsResultSchema(name: string): CanonicalResultSchema {
  const schema: unknown = Reflect.get(McpAppsSchemas, name);
  if (
    (typeof schema !== 'object' && typeof schema !== 'function') ||
    schema === null ||
    typeof Reflect.get(schema, 'safeParse') !== 'function'
  ) {
    throw new TypeError(`Pinned MCP Apps runtime result schema ${name} is unavailable`);
  }
  return schema as CanonicalResultSchema;
}

const CANONICAL_RESULT_SCHEMAS: Readonly<Record<McpAppRequestMethod, CanonicalResultSchema>> =
  Object.freeze({
    ping: EmptyResultSchema,
    'resources/read': ReadResourceResultSchema,
    'tools/call': CallToolResultSchema,
    'ui/initialize': requireMcpAppsResultSchema('McpUiInitializeResultSchema'),
    'ui/message': requireMcpAppsResultSchema('McpUiMessageResultSchema'),
    'ui/open-link': requireMcpAppsResultSchema('McpUiOpenLinkResultSchema'),
    'ui/request-display-mode': requireMcpAppsResultSchema('McpUiRequestDisplayModeResultSchema'),
    'ui/resource-teardown': requireMcpAppsResultSchema('McpUiResourceTeardownResultSchema'),
    'ui/update-model-context': EmptyResultSchema,
  });

function parseError(value: unknown, label: string): McpAppRpcError {
  const error = expectRecord(value, label);
  expectExactKeys(error, ['code', 'data', 'message'], ['code', 'message'], label);
  const code = error['code'];
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
    throw new TypeError(`${label}.code must be a safe integer`);
  }
  if (typeof error['message'] !== 'string') {
    throw new TypeError(`${label}.message must be a string`);
  }
  return Object.freeze({
    code,
    ...(error['data'] === undefined
      ? {}
      : { data: parseMcpAppJsonValue(error['data'], `${label}.data`) }),
    message: error['message'],
  });
}

export function parseMcpAppResponse(value: unknown, method: McpAppRequestMethod): McpAppResponse {
  const label = 'MCP Apps response';
  const record = expectRecord(value, label);
  const success = Object.hasOwn(record, 'result');
  expectExactKeys(
    record,
    success ? ['id', 'jsonrpc', 'result'] : ['error', 'id', 'jsonrpc'],
    success ? ['id', 'jsonrpc', 'result'] : ['error', 'id', 'jsonrpc'],
    label
  );
  if (record['jsonrpc'] !== '2.0') {
    throw new TypeError(`${label}.jsonrpc must be "2.0"`);
  }
  const parsed: McpAppResponse = success
    ? Object.freeze({
        id: parseMcpAppRequestId(record['id'], label),
        jsonrpc: '2.0' as const,
        result: parseMcpAppJsonRecord(record['result'], `${label}.result`),
      })
    : Object.freeze({
        error: parseError(record['error'], `${label}.error`),
        id: record['id'] === null ? null : parseMcpAppRequestId(record['id'], label),
        jsonrpc: '2.0' as const,
      });
  expectEncodedSize(parsed, MCP_APP_MAX_MESSAGE_BYTES, label);
  if ('result' in parsed && !CANONICAL_RESULT_SCHEMAS[method].safeParse(parsed.result).success) {
    throw new TypeError(`${label} ${method}.result does not match its canonical result schema`);
  }
  return parsed;
}

export function parseMcpAppResponseId(value: unknown): number | string {
  const record = expectRecord(value, 'MCP Apps response');
  return parseMcpAppRequestId(record['id'], 'MCP Apps response');
}

const MAX_PENDING_REQUESTS = 256;
/**
 * Replay defence, not a session lifetime: the correlator remembers the most
 * recent one-shot ids in a bounded ring and evicts the oldest, so a long-lived
 * app never exhausts its id space while the pending set stays the authority.
 */
const RECENT_REQUEST_IDS = 4096;

export class McpAppRequestCorrelator {
  readonly #pending = new Map<string, McpAppRequestMethod>();
  readonly #seen = new Set<string>();

  get pendingCount(): number {
    return this.#pending.size;
  }

  register(value: unknown, method: McpAppRequestMethod): number | string {
    const id = parseMcpAppRequestId(value, 'MCP Apps request');
    const key = correlationKey(id);
    if (this.#pending.has(key)) {
      throw new TypeError(`MCP Apps request id ${JSON.stringify(id)} is already pending`);
    }
    if (this.#seen.has(key)) {
      throw new TypeError(`MCP Apps request id ${JSON.stringify(id)} was already used`);
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new TypeError(`MCP Apps request correlation exceeds ${MAX_PENDING_REQUESTS} entries`);
    }
    this.#seen.add(key);
    if (this.#seen.size > RECENT_REQUEST_IDS) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
    this.#pending.set(key, method);
    return id;
  }

  settle(value: unknown): McpAppResponse {
    const label = 'MCP Apps response';
    const record = expectRecord(value, label);
    if (record['id'] === null) {
      // JSON-RPC 2.0 §5: the responder could not read the request id. Keep
      // the payload readable for diagnostics; nothing pending can own it.
      const failure = Object.hasOwn(record, 'error')
        ? parseError(record['error'], `${label}.error`)
        : undefined;
      throw new TypeError(
        `MCP Apps error response has no routable id: ${failure ? `${failure.code} ${failure.message}` : 'missing error'}`
      );
    }
    const id = parseMcpAppRequestId(record['id'], label);
    const key = correlationKey(id);
    const method = this.#pending.get(key);
    if (method === undefined) {
      throw new TypeError(`MCP Apps response id ${JSON.stringify(id)} is not pending`);
    }
    // A malformed reply still consumes the request it answers: an app must
    // not be able to wedge the channel by answering badly 256 times.
    this.#pending.delete(key);
    return parseMcpAppResponse(value, method);
  }

  /** Releases an abandoned request (timeout, abort, send failure). */
  cancel(id: number | string): boolean {
    return this.#pending.delete(correlationKey(id));
  }

  /** Releases every pending request; used on transport close. */
  clear(): void {
    this.#pending.clear();
  }

  /** Forgets pending AND one-shot ids: a new frame binding starts a fresh id space. */
  reset(): void {
    this.#pending.clear();
    this.#seen.clear();
  }
}
