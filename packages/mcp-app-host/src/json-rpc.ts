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
      id: number | string;
      jsonrpc: '2.0';
    }>;

type McpAppRpcError = Readonly<{ code: number; data?: unknown; message: string }>;

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

export function parseMcpAppResponse(value: unknown): McpAppResponse {
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
  const id = parseMcpAppRequestId(record['id'], label);
  const parsed: McpAppResponse = success
    ? Object.freeze({
        id,
        jsonrpc: '2.0' as const,
        result: parseMcpAppJsonRecord(record['result'], `${label}.result`),
      })
    : Object.freeze({
        error: parseError(record['error'], `${label}.error`),
        id,
        jsonrpc: '2.0' as const,
      });
  expectEncodedSize(parsed, MCP_APP_MAX_MESSAGE_BYTES, label);
  return parsed;
}

const MAX_PENDING_REQUESTS = 256;

function correlationKey(id: number | string): string {
  return `${typeof id}:${id}`;
}

export class McpAppRequestCorrelator {
  readonly #pending = new Set<string>();

  get pendingCount(): number {
    return this.#pending.size;
  }

  register(value: unknown): number | string {
    const id = parseMcpAppRequestId(value, 'MCP Apps request');
    const key = correlationKey(id);
    if (this.#pending.has(key)) {
      throw new TypeError(`MCP Apps request id ${JSON.stringify(id)} is already pending`);
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new TypeError(`MCP Apps request correlation exceeds ${MAX_PENDING_REQUESTS} entries`);
    }
    this.#pending.add(key);
    return id;
  }

  settle(value: unknown): McpAppResponse {
    const response = parseMcpAppResponse(value);
    const key = correlationKey(response.id);
    if (!this.#pending.delete(key)) {
      throw new TypeError(`MCP Apps response id ${JSON.stringify(response.id)} is not pending`);
    }
    return response;
  }
}
