import {
  CallToolRequestSchema,
  LoggingMessageNotificationSchema,
  PingRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/core';
import {
  McpUiHostContextChangedNotificationSchema,
  McpUiInitializedNotificationSchema,
  McpUiInitializeRequestSchema,
  McpUiMessageRequestSchema,
  McpUiOpenLinkRequestSchema,
  McpUiRequestDisplayModeRequestSchema,
  McpUiResourceTeardownRequestSchema,
  McpUiSandboxProxyReadyNotificationSchema,
  McpUiSandboxResourceReadyNotificationSchema,
  McpUiSizeChangedNotificationSchema,
  McpUiToolCancelledNotificationSchema,
  McpUiToolInputNotificationSchema,
  McpUiToolInputPartialNotificationSchema,
  McpUiToolResultNotificationSchema,
  McpUiUpdateModelContextRequestSchema,
} from '@modelcontextprotocol/ext-apps';
import { MCP_APPS_SPEC_VERSION } from './capabilities.ts';
import { parseMcpAppResourceMeta } from './metadata.ts';
import { MCP_APPS_STABLE_METHODS, type McpAppStableMethod } from './stable-contract.ts';
import {
  expectEncodedSize,
  expectExactKeys,
  expectRecord,
  MCP_APP_MAX_MESSAGE_BYTES,
  type UnknownRecord,
} from './validation.ts';
export type McpAppMessageDirection =
  | 'app-to-host'
  | 'host-to-app'
  | 'sandbox-to-host'
  | 'host-to-sandbox';

export interface McpAppMessage {
  readonly id?: number | string;
  readonly jsonrpc: '2.0';
  readonly method: McpAppStableMethod;
  readonly params?: Readonly<UnknownRecord>;
}

const STABLE_METHOD_SET = new Set<string>(MCP_APPS_STABLE_METHODS);

interface CanonicalMessageSchema {
  safeParse(value: unknown):
    | { readonly data: { readonly params?: unknown }; readonly success: true }
    | {
        readonly error: {
          readonly issues: readonly {
            readonly message: string;
            readonly path: readonly PropertyKey[];
          }[];
        };
        readonly success: false;
      };
}

const CANONICAL_MESSAGE_SCHEMAS: Readonly<Record<McpAppStableMethod, CanonicalMessageSchema>> =
  Object.freeze({
    'notifications/message': LoggingMessageNotificationSchema,
    ping: PingRequestSchema,
    'resources/read': ReadResourceRequestSchema,
    'tools/call': CallToolRequestSchema,
    'ui/initialize': McpUiInitializeRequestSchema,
    'ui/message': McpUiMessageRequestSchema,
    'ui/notifications/host-context-changed': McpUiHostContextChangedNotificationSchema,
    'ui/notifications/initialized': McpUiInitializedNotificationSchema,
    'ui/notifications/sandbox-proxy-ready': McpUiSandboxProxyReadyNotificationSchema,
    'ui/notifications/sandbox-resource-ready': McpUiSandboxResourceReadyNotificationSchema,
    'ui/notifications/size-changed': McpUiSizeChangedNotificationSchema,
    'ui/notifications/tool-cancelled': McpUiToolCancelledNotificationSchema,
    'ui/notifications/tool-input': McpUiToolInputNotificationSchema,
    'ui/notifications/tool-input-partial': McpUiToolInputPartialNotificationSchema,
    'ui/notifications/tool-result': McpUiToolResultNotificationSchema,
    'ui/open-link': McpUiOpenLinkRequestSchema,
    'ui/request-display-mode': McpUiRequestDisplayModeRequestSchema,
    'ui/resource-teardown': McpUiResourceTeardownRequestSchema,
    'ui/update-model-context': McpUiUpdateModelContextRequestSchema,
  });
const REQUEST_METHODS = new Set<McpAppStableMethod>([
  'ui/initialize',
  'ui/open-link',
  'ui/message',
  'ui/request-display-mode',
  'ui/update-model-context',
  'ui/resource-teardown',
  'tools/call',
  'resources/read',
  'ping',
]);

const METHODS_BY_DIRECTION: Readonly<
  Record<McpAppMessageDirection, ReadonlySet<McpAppStableMethod>>
> = Object.freeze({
  'app-to-host': new Set<McpAppStableMethod>([
    'ui/initialize',
    'ui/notifications/initialized',
    'ui/open-link',
    'ui/message',
    'ui/request-display-mode',
    'ui/update-model-context',
    'ui/notifications/size-changed',
    'tools/call',
    'resources/read',
    'notifications/message',
    'ping',
  ]),
  'host-to-app': new Set<McpAppStableMethod>([
    'ui/resource-teardown',
    // MCP ping is issued by either peer; the host uses it to detect a wedged
    // frame. tools/call reaches an app that declared its own tools.
    'ping',
    'tools/call',
    'ui/notifications/tool-input',
    'ui/notifications/tool-input-partial',
    'ui/notifications/tool-result',
    'ui/notifications/tool-cancelled',
    'ui/notifications/host-context-changed',
  ]),
  'host-to-sandbox': new Set<McpAppStableMethod>(['ui/notifications/sandbox-resource-ready']),
  'sandbox-to-host': new Set<McpAppStableMethod>(['ui/notifications/sandbox-proxy-ready']),
});

type JsonValue = boolean | null | number | string | readonly JsonValue[] | Readonly<UnknownRecord>;
interface JsonCloneContext {
  remainingNodes: number;
  readonly seen: Set<object>;
}

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;

function createJsonCloneContext(): JsonCloneContext {
  return { remainingNodes: MAX_JSON_NODES, seen: new Set<object>() };
}

function claimJsonNode(context: JsonCloneContext, label: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${label} exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
  }
  if (context.remainingNodes === 0) {
    throw new TypeError(`${label} exceeds the maximum JSON node count of ${MAX_JSON_NODES}`);
  }
  context.remainingNodes -= 1;
}

function defineOwnValue(target: UnknownRecord, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneJsonObject(
  record: UnknownRecord,
  label: string,
  context: JsonCloneContext,
  depth: number
): Readonly<UnknownRecord> {
  if (context.seen.has(record)) {
    throw new TypeError(`${label} must not contain cycles`);
  }
  context.seen.add(record);
  try {
    const parsed: UnknownRecord = {};
    for (const key of Object.keys(record)) {
      defineOwnValue(
        parsed,
        key,
        cloneJsonValue(record[key], `${label}.${key}`, context, depth + 1)
      );
    }
    return Object.freeze(parsed);
  } finally {
    context.seen.delete(record);
  }
}

function cloneJsonRecord(
  value: unknown,
  label: string,
  context = createJsonCloneContext(),
  depth = 0
): Readonly<UnknownRecord> {
  claimJsonNode(context, label, depth);
  const record = expectRecord(value, label);
  return cloneJsonObject(record, label, context, depth);
}

function cloneJsonValue(
  value: unknown,
  label: string,
  context = createJsonCloneContext(),
  depth = 0
): JsonValue {
  claimJsonNode(context, label, depth);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain only JSON values`);
  }
  if (context.seen.has(value)) {
    throw new TypeError(`${label} must not contain cycles`);
  }

  if (Array.isArray(value)) {
    context.seen.add(value);
    try {
      return Object.freeze(
        value.map((entry, index) => cloneJsonValue(entry, `${label}[${index}]`, context, depth + 1))
      );
    } finally {
      context.seen.delete(value);
    }
  }

  return cloneJsonObject(expectRecord(value, label), label, context, depth);
}

export function parseMcpAppJsonRecord(value: unknown, label: string): Readonly<UnknownRecord> {
  return cloneJsonRecord(value, label);
}

export function parseMcpAppJsonValue(value: unknown, label: string): JsonValue {
  return cloneJsonValue(value, label);
}

/**
 * The pinned schemas strip a field they don't define. The host refuses it
 * instead, so a frame cannot send what the stable contract leaves out.
 */
function expectNoStrippedFields(input: JsonValue, output: unknown, label: string): void {
  if (input === output || typeof input !== 'object' || input === null) {
    return;
  }
  if (typeof output !== 'object' || output === null) {
    throw new TypeError(`${label} does not match its canonical schema`);
  }
  if (Array.isArray(input)) {
    input.forEach((entry, index) => {
      expectNoStrippedFields(entry, Reflect.get(output, index), `${label}[${index}]`);
    });
    return;
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(output, key)) {
      throw new TypeError(`${label} contains unsupported field "${key}"`);
    }
    expectNoStrippedFields(
      (input as Readonly<UnknownRecord>)[key] as JsonValue,
      Reflect.get(output, key),
      `${label}.${key}`
    );
  }
}

function expectExternalUrl(url: unknown, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch (error: unknown) {
    throw new TypeError(`${label} must be a valid external URL`, { cause: error });
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new TypeError(`${label} must use http or https without embedded credentials`);
  }
}

type ParamsPolicy = (params: Readonly<UnknownRecord>, label: string) => void;

/** The host's own rules on top of the pinned schemas' shapes. */
const PARAMS_POLICIES: Readonly<Partial<Record<McpAppStableMethod, ParamsPolicy>>> = Object.freeze({
  'resources/read': (params, label) => {
    const uri = String(params['uri']);
    if (uri.length === 0 || uri.length > 2048) {
      throw new TypeError(`${label}.uri must contain 1 to 2048 characters`);
    }
    try {
      new URL(uri);
    } catch (error: unknown) {
      throw new TypeError(`${label}.uri must be an absolute URI`, { cause: error });
    }
  },
  'tools/call': (params, label) => {
    const name = String(params['name']);
    if (name.length === 0 || name.length > 256) {
      throw new TypeError(`${label}.name must contain 1 to 256 characters`);
    }
  },
  'ui/initialize': (params, label) => {
    if (params['protocolVersion'] !== MCP_APPS_SPEC_VERSION) {
      throw new TypeError(`${label}.protocolVersion must be "${MCP_APPS_SPEC_VERSION}"`);
    }
  },
  'ui/notifications/sandbox-resource-ready': (params) => {
    const { csp, permissions } = params;
    if (csp !== undefined || permissions !== undefined) {
      parseMcpAppResourceMeta({
        ...(csp === undefined ? {} : { csp }),
        ...(permissions === undefined ? {} : { permissions }),
      });
    }
  },
  'ui/open-link': (params, label) => {
    expectExternalUrl(params['url'], `${label}.url`);
  },
});

function parseStableMethod(value: unknown): McpAppStableMethod {
  if (typeof value !== 'string' || !STABLE_METHOD_SET.has(value)) {
    throw new TypeError('MCP Apps message method must be a stable MCP Apps method');
  }
  return value as McpAppStableMethod;
}

/**
 * A message's params are snapshotted as bounded plain JSON, checked against the
 * method's pinned SDK schema with nothing stripped, then held to host policy.
 */
function parseParams(
  method: McpAppStableMethod,
  value: unknown,
  label: string
): Readonly<UnknownRecord> {
  const params = cloneJsonRecord(value, label);
  const result = CANONICAL_MESSAGE_SCHEMAS[method].safeParse({ method, params });
  if (!result.success) {
    // An issue's path starts at the `{ method, params }` envelope.
    const [issue] = result.error.issues;
    const path =
      issue?.path
        .slice(1)
        .map((key) => `.${String(key)}`)
        .join('') ?? '';
    const detail = issue === undefined ? '' : `: ${issue.message}`;
    throw new TypeError(`${label}${path} does not match its canonical schema${detail}`);
  }
  expectNoStrippedFields(params, result.data.params, label);
  PARAMS_POLICIES[method]?.(params, label);
  return params;
}

function assertCanonicalMethod(method: McpAppStableMethod, label: string): void {
  const result = CANONICAL_MESSAGE_SCHEMAS[method].safeParse({ method });
  if (!result.success) {
    throw new TypeError(`${label} ${method} does not match its canonical schema`);
  }
}

function parseRequestId(value: unknown, label: string): number | string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new TypeError(`${label}.id must be a string or safe integer`);
}

export function parseMcpAppRequestId(value: unknown, label: string): number | string {
  return parseRequestId(value, label);
}

export function parseMcpAppMessage(
  value: unknown,
  direction: McpAppMessageDirection
): McpAppMessage {
  const label = 'MCP Apps message';
  const record = expectRecord(value, label);
  const method = parseStableMethod(record['method']);
  if (!METHODS_BY_DIRECTION[direction].has(method)) {
    throw new TypeError(`${label} method "${method}" is not allowed in direction "${direction}"`);
  }

  const isRequest = REQUEST_METHODS.has(method);
  const paramsOptional = method === 'ui/notifications/initialized' || method === 'ping';
  expectExactKeys(
    record,
    isRequest ? ['id', 'jsonrpc', 'method', 'params'] : ['jsonrpc', 'method', 'params'],
    isRequest
      ? paramsOptional
        ? ['id', 'jsonrpc', 'method']
        : ['id', 'jsonrpc', 'method', 'params']
      : paramsOptional
        ? ['jsonrpc', 'method']
        : ['jsonrpc', 'method', 'params'],
    label
  );
  if (record['jsonrpc'] !== '2.0') {
    throw new TypeError(`${label}.jsonrpc must be "2.0"`);
  }

  const params =
    record['params'] === undefined && paramsOptional
      ? undefined
      : parseParams(method, record['params'], `${label} ${method}.params`);
  if (params === undefined) {
    assertCanonicalMethod(method, label);
  }
  const parsed = Object.freeze({
    ...(isRequest ? { id: parseRequestId(record['id'], label) } : {}),
    jsonrpc: '2.0' as const,
    method,
    ...(params === undefined ? {} : { params }),
  });
  expectEncodedSize(parsed, MCP_APP_MAX_MESSAGE_BYTES, label);
  return parsed;
}
