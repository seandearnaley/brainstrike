import {
  CallToolRequestSchema,
  LoggingMessageNotificationSchema,
  PingRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/core';
import * as McpAppsSchemas from '@modelcontextprotocol/ext-apps';
import { MCP_APPS_SPEC_VERSION } from './capabilities.js';
import { parseMcpAppResourceMeta } from './metadata.js';
import { MCP_APPS_STABLE_METHODS, type McpAppStableMethod } from './stable-contract.js';
import {
  expectEncodedSize,
  expectExactKeys,
  expectRecord,
  MCP_APP_MAX_MESSAGE_BYTES,
  type UnknownRecord,
} from './validation.js';
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
  safeParse(value: unknown): { readonly success: boolean };
}

function requireMcpAppsSchema(name: string): CanonicalMessageSchema {
  const schema: unknown = Reflect.get(McpAppsSchemas, name);
  if (
    (typeof schema !== 'object' && typeof schema !== 'function') ||
    schema === null ||
    typeof Reflect.get(schema, 'safeParse') !== 'function'
  ) {
    throw new TypeError(`Pinned MCP Apps runtime schema ${name} is unavailable`);
  }
  return schema as CanonicalMessageSchema;
}

const CANONICAL_MESSAGE_SCHEMAS: Readonly<Record<McpAppStableMethod, CanonicalMessageSchema>> =
  Object.freeze({
    'notifications/message': LoggingMessageNotificationSchema,
    ping: PingRequestSchema,
    'resources/read': ReadResourceRequestSchema,
    'tools/call': CallToolRequestSchema,
    'ui/initialize': requireMcpAppsSchema('McpUiInitializeRequestSchema'),
    'ui/message': requireMcpAppsSchema('McpUiMessageRequestSchema'),
    'ui/notifications/host-context-changed': requireMcpAppsSchema(
      'McpUiHostContextChangedNotificationSchema'
    ),
    'ui/notifications/initialized': requireMcpAppsSchema('McpUiInitializedNotificationSchema'),
    'ui/notifications/sandbox-proxy-ready': requireMcpAppsSchema(
      'McpUiSandboxProxyReadyNotificationSchema'
    ),
    'ui/notifications/sandbox-resource-ready': requireMcpAppsSchema(
      'McpUiSandboxResourceReadyNotificationSchema'
    ),
    'ui/notifications/size-changed': requireMcpAppsSchema('McpUiSizeChangedNotificationSchema'),
    'ui/notifications/tool-cancelled': requireMcpAppsSchema('McpUiToolCancelledNotificationSchema'),
    'ui/notifications/tool-input': requireMcpAppsSchema('McpUiToolInputNotificationSchema'),
    'ui/notifications/tool-input-partial': requireMcpAppsSchema(
      'McpUiToolInputPartialNotificationSchema'
    ),
    'ui/notifications/tool-result': requireMcpAppsSchema('McpUiToolResultNotificationSchema'),
    'ui/open-link': requireMcpAppsSchema('McpUiOpenLinkRequestSchema'),
    'ui/request-display-mode': requireMcpAppsSchema('McpUiRequestDisplayModeRequestSchema'),
    'ui/resource-teardown': requireMcpAppsSchema('McpUiResourceTeardownRequestSchema'),
    'ui/update-model-context': requireMcpAppsSchema('McpUiUpdateModelContextRequestSchema'),
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

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

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

function parseEmptyParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, [], [], label);
  return Object.freeze({});
}

function parseImplementation(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(
    record,
    ['description', 'icons', 'name', 'title', 'version', 'websiteUrl'],
    ['name', 'version'],
    label
  );
  const parsed: UnknownRecord = {
    name: expectString(record['name'], `${label}.name`),
    version: expectString(record['version'], `${label}.version`),
  };
  for (const key of ['description', 'title', 'websiteUrl'] as const) {
    if (record[key] !== undefined) {
      parsed[key] = expectString(record[key], `${label}.${key}`);
    }
  }
  if (record['icons'] !== undefined) {
    if (!Array.isArray(record['icons'])) {
      throw new TypeError(`${label}.icons must be an array`);
    }
    parsed['icons'] = Object.freeze(
      record['icons'].map((value, index) => {
        const iconLabel = `${label}.icons[${index}]`;
        const icon = expectRecord(value, iconLabel);
        expectExactKeys(icon, ['mimeType', 'sizes', 'src', 'theme'], ['src'], iconLabel);
        const parsedIcon: UnknownRecord = {
          src: expectString(icon['src'], `${iconLabel}.src`),
        };
        if (icon['mimeType'] !== undefined) {
          parsedIcon['mimeType'] = expectString(icon['mimeType'], `${iconLabel}.mimeType`);
        }
        if (icon['sizes'] !== undefined) {
          if (
            !Array.isArray(icon['sizes']) ||
            icon['sizes'].some((size) => typeof size !== 'string')
          ) {
            throw new TypeError(`${iconLabel}.sizes must be an array of strings`);
          }
          parsedIcon['sizes'] = Object.freeze([...icon['sizes']]);
        }
        if (icon['theme'] !== undefined) {
          if (icon['theme'] !== 'light' && icon['theme'] !== 'dark') {
            throw new TypeError(`${iconLabel}.theme must be "light" or "dark"`);
          }
          parsedIcon['theme'] = icon['theme'];
        }
        return Object.freeze(parsedIcon);
      })
    );
  }
  return Object.freeze(parsed);
}

function parseExperimentalCapabilities(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  const parsed: UnknownRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    defineOwnValue(parsed, key, parseJsonRecord(entry, `${label}.${key}`));
  }
  return Object.freeze(parsed);
}

function parseAppCapabilities(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['availableDisplayModes', 'experimental', 'tools'], [], label);

  const parsed: UnknownRecord = {};
  if (record['experimental'] !== undefined) {
    parsed['experimental'] = parseExperimentalCapabilities(
      record['experimental'],
      `${label}.experimental`
    );
  }
  if (record['tools'] !== undefined) {
    const tools = expectRecord(record['tools'], `${label}.tools`);
    expectExactKeys(tools, ['listChanged'], [], `${label}.tools`);
    parsed['tools'] = Object.freeze(
      tools['listChanged'] === undefined
        ? {}
        : { listChanged: expectBoolean(tools['listChanged'], `${label}.tools['listChanged']`) }
    );
  }
  if (record['availableDisplayModes'] !== undefined) {
    if (
      !Array.isArray(record['availableDisplayModes']) ||
      record['availableDisplayModes'].some(
        (mode) => mode !== 'inline' && mode !== 'fullscreen' && mode !== 'pip'
      )
    ) {
      throw new TypeError(
        `${label}.availableDisplayModes must contain only "inline", "fullscreen", or "pip"`
      );
    }
    parsed['availableDisplayModes'] = Object.freeze([...record['availableDisplayModes']]);
  }
  return Object.freeze(parsed);
}

function parseInitializeParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(
    record,
    ['appCapabilities', 'appInfo', 'protocolVersion'],
    ['appCapabilities', 'appInfo', 'protocolVersion'],
    label
  );
  if (record['protocolVersion'] !== MCP_APPS_SPEC_VERSION) {
    throw new TypeError(`${label}.protocolVersion must be "${MCP_APPS_SPEC_VERSION}"`);
  }
  return Object.freeze({
    appCapabilities: parseAppCapabilities(record['appCapabilities'], `${label}.appCapabilities`),
    appInfo: parseImplementation(record['appInfo'], `${label}.appInfo`),
    protocolVersion: MCP_APPS_SPEC_VERSION,
  });
}

function parseContentBlocks(value: unknown, label: string): readonly Readonly<UnknownRecord>[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of MCP content blocks`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      const block = cloneJsonRecord(entry, `${label}[${index}]`);
      if (typeof block['type'] !== 'string') {
        throw new TypeError(`${label}[${index}].type must be a string`);
      }
      return block;
    })
  );
}

function parseJsonRecord(value: unknown, label: string): Readonly<UnknownRecord> {
  return cloneJsonRecord(value, label);
}

export function parseMcpAppJsonRecord(value: unknown, label: string): Readonly<UnknownRecord> {
  return cloneJsonRecord(value, label);
}

export function parseMcpAppJsonValue(value: unknown, label: string): JsonValue {
  return cloneJsonValue(value, label);
}

type ParamsParser = (value: unknown, label: string) => Readonly<UnknownRecord>;

function parseOpenLinkParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['url'], ['url'], label);
  const url = expectString(record['url'], `${label}.url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error: unknown) {
    throw new TypeError(`${label}.url must be a valid external URL`, { cause: error });
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new TypeError(`${label}.url must use http or https without embedded credentials`);
  }
  return Object.freeze({ url });
}

function parseMessageParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['content', 'role'], ['content', 'role'], label);
  if (record['role'] !== 'user') {
    throw new TypeError(`${label}.role must be "user"`);
  }
  return Object.freeze({
    content: parseContentBlocks(record['content'], `${label}.content`),
    role: 'user',
  });
}

function parseDisplayModeParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['mode'], ['mode'], label);
  if (record['mode'] !== 'inline' && record['mode'] !== 'fullscreen' && record['mode'] !== 'pip') {
    throw new TypeError(`${label}.mode must be "inline", "fullscreen", or "pip"`);
  }
  return Object.freeze({ mode: record['mode'] });
}

function parseUpdateModelContextParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['content', 'structuredContent'], [], label);
  const parsed: UnknownRecord = {};
  if (record['content'] !== undefined) {
    parsed['content'] = parseContentBlocks(record['content'], `${label}.content`);
  }
  if (record['structuredContent'] !== undefined) {
    parsed['structuredContent'] = parseJsonRecord(
      record['structuredContent'],
      `${label}.structuredContent`
    );
  }
  return Object.freeze(parsed);
}

function parseSizeChangedParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['height', 'width'], [], label);
  const parsed: UnknownRecord = {};
  if (record['height'] !== undefined) {
    parsed['height'] = expectNumber(record['height'], `${label}.height`);
  }
  if (record['width'] !== undefined) {
    parsed['width'] = expectNumber(record['width'], `${label}.width`);
  }
  return Object.freeze(parsed);
}

function parseToolInputParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['arguments'], [], label);
  return Object.freeze(
    record['arguments'] === undefined
      ? {}
      : { arguments: parseJsonRecord(record['arguments'], `${label}.arguments`) }
  );
}

function parseToolCancelledParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['reason'], [], label);
  return Object.freeze(
    record['reason'] === undefined
      ? {}
      : { reason: expectString(record['reason'], `${label}.reason`) }
  );
}

function parseSandboxResourceParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['csp', 'html', 'permissions', 'sandbox'], ['html'], label);
  const parsed: UnknownRecord = { html: expectString(record['html'], `${label}.html`) };
  if (record['sandbox'] !== undefined) {
    parsed['sandbox'] = expectString(record['sandbox'], `${label}.sandbox`);
  }
  if (record['csp'] !== undefined || record['permissions'] !== undefined) {
    const meta = parseMcpAppResourceMeta({
      ...(record['csp'] === undefined ? {} : { csp: record['csp'] }),
      ...(record['permissions'] === undefined ? {} : { permissions: record['permissions'] }),
    });
    if (meta.csp !== undefined) {
      parsed['csp'] = meta.csp;
    }
    if (meta.permissions !== undefined) {
      parsed['permissions'] = meta.permissions;
    }
  }
  return Object.freeze(parsed);
}

function parseOptionalMeta(
  record: UnknownRecord,
  label: string
): Readonly<UnknownRecord> | undefined {
  return record['_meta'] === undefined
    ? undefined
    : parseJsonRecord(record['_meta'], `${label}._meta`);
}

function parseCallToolParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['_meta', 'arguments', 'name'], ['name'], label);
  const name = expectString(record['name'], `${label}.name`);
  if (name.length === 0 || name.length > 256) {
    throw new TypeError(`${label}.name must contain 1 to 256 characters`);
  }
  const meta = parseOptionalMeta(record, label);
  return Object.freeze({
    ...(meta === undefined ? {} : { _meta: meta }),
    ...(record['arguments'] === undefined
      ? {}
      : { arguments: parseJsonRecord(record['arguments'], `${label}.arguments`) }),
    name,
  });
}

function parseReadResourceParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['_meta', 'uri'], ['uri'], label);
  const uri = expectString(record['uri'], `${label}.uri`);
  if (uri.length === 0 || uri.length > 2048) {
    throw new TypeError(`${label}.uri must contain 1 to 2048 characters`);
  }
  try {
    new URL(uri);
  } catch (error: unknown) {
    throw new TypeError(`${label}.uri must be an absolute URI`, { cause: error });
  }
  const meta = parseOptionalMeta(record, label);
  return Object.freeze({ ...(meta === undefined ? {} : { _meta: meta }), uri });
}

const LOG_LEVELS = new Set([
  'alert',
  'critical',
  'debug',
  'emergency',
  'error',
  'info',
  'notice',
  'warning',
]);

function parseLoggingParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['_meta', 'data', 'level', 'logger'], ['data', 'level'], label);
  if (typeof record['level'] !== 'string' || !LOG_LEVELS.has(record['level'])) {
    throw new TypeError(`${label}.level must be a standard MCP logging level`);
  }
  const meta = parseOptionalMeta(record, label);
  return Object.freeze({
    ...(meta === undefined ? {} : { _meta: meta }),
    data: cloneJsonValue(record['data'], `${label}.data`),
    level: record['level'],
    ...(record['logger'] === undefined
      ? {}
      : { logger: expectString(record['logger'], `${label}.logger`) }),
  });
}

function parsePingParams(value: unknown, label: string): Readonly<UnknownRecord> {
  const record = expectRecord(value, label);
  expectExactKeys(record, ['_meta'], [], label);
  const meta = parseOptionalMeta(record, label);
  return Object.freeze(meta === undefined ? {} : { _meta: meta });
}

const PARAMS_PARSERS: Readonly<Record<McpAppStableMethod, ParamsParser>> = Object.freeze({
  'notifications/message': parseLoggingParams,
  ping: parsePingParams,
  'resources/read': parseReadResourceParams,
  'tools/call': parseCallToolParams,
  'ui/initialize': parseInitializeParams,
  'ui/message': parseMessageParams,
  'ui/notifications/host-context-changed': parseJsonRecord,
  'ui/notifications/initialized': parseEmptyParams,
  'ui/notifications/sandbox-proxy-ready': parseEmptyParams,
  'ui/notifications/sandbox-resource-ready': parseSandboxResourceParams,
  'ui/notifications/size-changed': parseSizeChangedParams,
  'ui/notifications/tool-cancelled': parseToolCancelledParams,
  'ui/notifications/tool-input': parseToolInputParams,
  'ui/notifications/tool-input-partial': parseToolInputParams,
  'ui/notifications/tool-result': parseJsonRecord,
  'ui/open-link': parseOpenLinkParams,
  'ui/request-display-mode': parseDisplayModeParams,
  'ui/resource-teardown': parseEmptyParams,
  'ui/update-model-context': parseUpdateModelContextParams,
});

function parseMethodParams(
  method: McpAppStableMethod,
  value: unknown,
  label: string
): Readonly<UnknownRecord> {
  return PARAMS_PARSERS[method](value, label);
}

function parseStableMethod(value: unknown): McpAppStableMethod {
  if (typeof value !== 'string' || !STABLE_METHOD_SET.has(value)) {
    throw new TypeError('MCP Apps message method must be a stable MCP Apps method');
  }
  return value as McpAppStableMethod;
}

function assertCanonicalMessage(
  method: McpAppStableMethod,
  params: unknown,
  hasParams: boolean,
  label: string
): void {
  const message = hasParams ? { method, params } : { method };
  if (!CANONICAL_MESSAGE_SCHEMAS[method].safeParse(message).success) {
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

  assertCanonicalMessage(method, record['params'], record['params'] !== undefined, label);

  const params =
    record['params'] === undefined && paramsOptional
      ? undefined
      : parseMethodParams(method, record['params'], `${label} ${method}.params`);
  const parsed = Object.freeze({
    ...(isRequest ? { id: parseRequestId(record['id'], label) } : {}),
    jsonrpc: '2.0' as const,
    method,
    ...(params === undefined ? {} : { params }),
  });
  expectEncodedSize(parsed, MCP_APP_MAX_MESSAGE_BYTES, label);
  return parsed;
}
