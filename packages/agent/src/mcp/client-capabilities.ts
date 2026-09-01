import type {
  Client,
  ClientCapabilities,
  ClientContext,
  ClientOptions,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  ListRootsResult,
  LoggingLevel,
  LoggingMessageNotification,
} from '@modelcontextprotocol/client';
import {
  type McpClientCapabilityCloseReport,
  McpClientCapabilityLeaseOwner,
} from './client-capability-lease';

export type { McpClientCapabilityCloseReport } from './client-capability-lease';

export const DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS = 8;
export const MCP_SDK_INPUT_REQUIRED_MAX_ROUNDS = 10;
export const MCP_CLIENT_INPUT_MAX_BYTES = 32_768;

const REDACTED = '[REDACTED]';
const SENSITIVE_LOG_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/iu;
const SENSITIVE_FORM_IDENTIFIER =
  /(?:^| )(?:credential|cvc|cvv|passcode|passphrase|password|secret|token)(?: |$)|^(?:api key|access key|private key|credit card|card number|bank account|payment method)$/u;
const LOG_LEVELS: readonly LoggingLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

export interface McpClientHandlerContext {
  readonly requestId: number | string;
  readonly serverName: string;
  readonly signal: AbortSignal;
}

export interface McpElicitationCapability<
  Context extends McpClientHandlerContext = McpClientHandlerContext,
> {
  readonly applyDefaults?: boolean;
  readonly form: boolean;
  readonly handle: (request: ElicitRequest, context: Context) => Promise<ElicitResult>;
  readonly url: boolean;
  readonly urlPolicy?: McpUrlElicitationPolicy;
}

export interface McpRootsCapability {
  readonly handle: (context: McpClientHandlerContext) => Promise<ListRootsResult>;
  readonly listChanged: boolean;
}

export interface McpSamplingCapability {
  readonly handle: (
    request: CreateMessageRequest,
    context: McpClientHandlerContext
  ) => Promise<CreateMessageResult>;
}

export interface McpLoggingCompatibility {
  readonly handle: (entry: SanitizedMcpServerLog & { readonly serverName: string }) => void;
  readonly minimumLevel: LoggingLevel;
}

export interface McpClientCapabilityOptions {
  readonly elicitation?: McpElicitationCapability;
  readonly logging?: McpLoggingCompatibility;
  readonly maxInputRequiredRounds?: number;
  readonly roots?: McpRootsCapability;
  readonly sampling?: McpSamplingCapability;
}

export interface SanitizedMcpServerLog {
  readonly data: unknown;
  readonly level: LoggingLevel;
  readonly remoteLogger?: string;
}

export interface McpClientCapabilityRuntime {
  afterConnect(client: Client, signal?: AbortSignal): Promise<void>;
  readonly capabilities: ClientCapabilities;
  readonly inputRequired: NonNullable<ClientOptions['inputRequired']>;
  install(client: Client, serverName: string): McpClientCapabilityLease;
}

export interface McpClientCapabilityLease {
  close(): Promise<McpClientCapabilityCloseReport>;
}

export type McpUrlElicitationPolicy = 'https-only' | 'https-or-loopback-http-development';

export interface McpTransportCapabilityConfiguration {
  readonly clientCapabilities?: McpClientCapabilityOptions;
  readonly inputRequired?: ClientOptions['inputRequired'];
}

export interface McpTransportCapabilities {
  readonly inputRequired: NonNullable<ClientOptions['inputRequired']>;
  readonly runtime: McpClientCapabilityRuntime;
}

type McpFormElicitationRequest = ElicitRequest & { params: ElicitRequestFormParams };
type McpUrlElicitationRequest = ElicitRequest & { params: ElicitRequestURLParams };

export interface McpElicitationPresenter {
  readonly confirmUrl: (
    request: McpUrlElicitationRequest,
    context: McpClientHandlerContext
  ) => Promise<Pick<ElicitResult, 'action'>>;
  readonly form: boolean;
  readonly openExternal: (url: URL, context: McpClientHandlerContext) => Promise<void>;
  readonly presentForm: (
    request: McpFormElicitationRequest,
    context: McpClientHandlerContext
  ) => Promise<ElicitResult>;
  readonly url: boolean;
  readonly urlPolicy?: McpUrlElicitationPolicy;
}

export interface McpAdvisoryRoot {
  readonly name?: string;
  readonly uri: string;
}

function normalizeMaxRounds(value: unknown, field = 'MCP input-required round cap'): number {
  const rounds = value ?? DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS;
  if (typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  if (rounds > MCP_SDK_INPUT_REQUIRED_MAX_ROUNDS) {
    throw new Error(`${field} must be at most ${MCP_SDK_INPUT_REQUIRED_MAX_ROUNDS}`);
  }
  return rounds;
}

function cloneCapabilities(options: McpClientCapabilityOptions): ClientCapabilities {
  const capabilities: ClientCapabilities = {};
  if (options.elicitation) {
    if (!(options.elicitation.form || options.elicitation.url)) {
      throw new Error('MCP elicitation capability must enable at least one mode');
    }
    if (options.elicitation.applyDefaults !== undefined && !options.elicitation.form) {
      throw new Error('MCP elicitation default application requires form mode');
    }
    capabilities.elicitation = {
      ...(options.elicitation.form
        ? {
            form:
              options.elicitation.applyDefaults === undefined
                ? {}
                : { applyDefaults: options.elicitation.applyDefaults },
          }
        : {}),
      ...(options.elicitation.url ? { url: {} } : {}),
    };
  }
  if (options.roots) {
    capabilities.roots = { listChanged: options.roots.listChanged };
  }
  if (options.sampling) {
    capabilities.sampling = {};
  }
  return capabilities;
}

function handlerContext(
  serverName: string,
  context: ClientContext,
  signal = context.mcpReq.signal
): McpClientHandlerContext {
  return {
    requestId: context.mcpReq.id,
    serverName,
    signal,
  };
}

function resolveElicitationMode(request: ElicitRequest): 'form' | 'url' {
  const mode = request.params.mode;
  switch (mode) {
    case undefined:
    case 'form':
      return 'form';
    case 'url':
      return 'url';
    default:
      return assertUnreachable(mode);
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported MCP elicitation mode: ${String(value)}`);
}

function installHandlers(
  client: Client,
  serverName: string,
  options: McpClientCapabilityOptions
): McpClientCapabilityLease {
  const lease = new McpClientCapabilityLeaseOwner(client);
  try {
    if (options.elicitation) {
      const capability = options.elicitation;
      client.setRequestHandler('elicitation/create', (request, context) =>
        lease.track(
          context.mcpReq.signal,
          async (signal) =>
            await fulfillMcpElicitationRequest(
              capability,
              request,
              handlerContext(serverName, context, signal)
            )
        )
      );
      lease.recordRequestHandler('elicitation/create');
    }
    if (options.roots) {
      const capability = options.roots;
      client.setRequestHandler('roots/list', (_request, context) =>
        lease.track(context.mcpReq.signal, (signal) =>
          capability.handle(handlerContext(serverName, context, signal))
        )
      );
      lease.recordRequestHandler('roots/list');
    }
    if (options.sampling) {
      const capability = options.sampling;
      client.setRequestHandler('sampling/createMessage', (request, context) =>
        lease.track(context.mcpReq.signal, async (signal) => {
          assertBoundedJson(request, 'MCP sampling request');
          return await capability.handle(request, handlerContext(serverName, context, signal));
        })
      );
      lease.recordRequestHandler('sampling/createMessage');
    }
    if (options.logging) {
      const compatibility = options.logging;
      client.setNotificationHandler('notifications/message', (notification) => {
        if (!isAllowedLogLevel(notification.params.level, compatibility.minimumLevel)) {
          return;
        }
        compatibility.handle({ ...sanitizeMcpServerLog(notification.params), serverName });
      });
      lease.recordNotificationHandler('notifications/message');
    }
    return lease;
  } catch (error) {
    return lease.rollbackInstall(error);
  }
}

export async function fulfillMcpElicitationRequest<Context extends McpClientHandlerContext>(
  capability: McpElicitationCapability<Context>,
  request: ElicitRequest,
  context: Context
): Promise<ElicitResult> {
  const mode = resolveElicitationMode(request);
  if ((mode === 'form' && !capability.form) || (mode === 'url' && !capability.url)) {
    throw new Error(`MCP elicitation mode "${mode}" is not enabled for "${context.serverName}"`);
  }
  validateMcpElicitationRequest(request, capability.urlPolicy ?? 'https-only');
  const result = await capability.handle(request, context);
  validateMcpElicitationResult(request, result);
  return result;
}

export function createMcpClientCapabilityRuntime(
  options: McpClientCapabilityOptions
): McpClientCapabilityRuntime {
  const capabilities = cloneCapabilities(options);
  const inputRequired = {
    autoFulfill: true,
    maxRounds: normalizeMaxRounds(options.maxInputRequiredRounds),
  } satisfies NonNullable<ClientOptions['inputRequired']>;
  return {
    async afterConnect(client, signal) {
      if (!(options.logging && client.getServerCapabilities()?.logging)) {
        return;
      }
      await client.setLoggingLevel(options.logging.minimumLevel, signal ? { signal } : undefined);
    },
    capabilities,
    inputRequired,
    install: (client, serverName) => installHandlers(client, serverName, options),
  };
}

export function composeMcpTransportCapabilities(
  configuration: McpTransportCapabilityConfiguration
): McpTransportCapabilities {
  const clientCapabilities = configuration.clientCapabilities ?? {};
  const configuredInput = configuration.inputRequired;
  if (
    clientCapabilities.maxInputRequiredRounds !== undefined &&
    configuredInput?.maxRounds !== undefined
  ) {
    throw new Error(
      'MCP clientCapabilities.maxInputRequiredRounds and inputRequired.maxRounds must not both configure the round cap'
    );
  }
  if (
    configuredInput?.autoFulfill !== undefined &&
    typeof configuredInput.autoFulfill !== 'boolean'
  ) {
    throw new Error('MCP inputRequired.autoFulfill must be a boolean');
  }
  if (configuredInput?.maxRounds !== undefined) {
    normalizeMaxRounds(configuredInput.maxRounds, 'MCP inputRequired.maxRounds');
  }
  const runtime = createMcpClientCapabilityRuntime(clientCapabilities);
  return {
    inputRequired: { ...runtime.inputRequired, ...configuredInput },
    runtime,
  };
}

export function createMcpElicitationCapability(
  presenter: McpElicitationPresenter
): McpElicitationCapability {
  return {
    form: presenter.form,
    async handle(request, context) {
      validateMcpElicitationRequest(request, presenter.urlPolicy ?? 'https-only');
      const mode = resolveElicitationMode(request);
      if (mode === 'form') {
        const result = await presenter.presentForm(request as McpFormElicitationRequest, context);
        validateMcpElicitationResult(request, result);
        return result;
      }
      const urlRequest = request as McpUrlElicitationRequest;
      const url = assertElicitationUrl(urlRequest.params.url, presenter.urlPolicy ?? 'https-only');
      const decision = await presenter.confirmUrl(urlRequest, context);
      if (decision.action !== 'accept') {
        return decision;
      }
      await presenter.openExternal(url, context);
      return { action: 'accept' };
    },
    url: presenter.url,
    urlPolicy: presenter.urlPolicy ?? 'https-only',
  };
}

export function createMcpRootsCapability(options: {
  readonly listChanged: boolean;
  readonly roots: readonly McpAdvisoryRoot[];
}): McpRootsCapability {
  const roots = options.roots.map((root) => {
    const uri = new URL(root.uri);
    if (uri.protocol !== 'file:') {
      throw new Error('MCP advisory roots must use file: URIs');
    }
    return Object.freeze({
      ...(root.name === undefined ? {} : { name: root.name }),
      uri: uri.href,
    });
  });
  const snapshot = Object.freeze(roots);
  return {
    handle: async () => ({ roots: snapshot.map((root) => ({ ...root })) }),
    listChanged: options.listChanged,
  };
}

export function validateMcpElicitationRequest(
  request: ElicitRequest,
  urlPolicy: McpUrlElicitationPolicy = 'https-only'
): void {
  assertBoundedJson(request, 'MCP elicitation request');
  if (request.params.message.length > 8192) {
    throw new Error('MCP elicitation message exceeds 8192 characters');
  }
  const mode = resolveElicitationMode(request);
  if (mode === 'form') {
    const formRequest = request as McpFormElicitationRequest;
    for (const [propertyName, definition] of Object.entries(
      formRequest.params.requestedSchema.properties
    )) {
      if (isSensitiveFormIdentifier(propertyName) || hasSensitiveFormHint(definition)) {
        throw new Error('MCP form elicitation may not request sensitive information; use URL mode');
      }
    }
    return;
  }
  assertElicitationUrl((request as McpUrlElicitationRequest).params.url, urlPolicy);
}

function isSensitiveFormIdentifier(value: string): boolean {
  const normalized = value
    .replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/gu, ' ')
    .trim();
  return SENSITIVE_FORM_IDENTIFIER.test(normalized);
}

function hasSensitiveFormHint(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current && typeof current === 'object')) {
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      const metadataHint =
        (key === 'format' || key === 'title') &&
        typeof entry === 'string' &&
        isSensitiveFormIdentifier(entry);
      if (isSensitiveFormIdentifier(key) || metadataHint) {
        return true;
      }
      if (entry && typeof entry === 'object') {
        pending.push(entry);
      }
    }
  }
  return false;
}

function assertElicitationUrl(input: string, policy: McpUrlElicitationPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('MCP URL elicitation requires HTTPS without embedded credentials');
  }
  if (url.username || url.password) {
    throw new Error('MCP URL elicitation requires HTTPS without embedded credentials');
  }
  if (url.protocol === 'https:') {
    return url;
  }
  if (
    policy === 'https-or-loopback-http-development' &&
    url.protocol === 'http:' &&
    isLoopbackHostname(url.hostname)
  ) {
    return url;
  }
  throw new Error('MCP URL elicitation requires HTTPS without embedded credentials');
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  return match?.slice(1).every((part) => Number(part) <= 255) ?? false;
}

export function validateMcpElicitationResult(request: ElicitRequest, result: ElicitResult): void {
  assertBoundedJson(result, 'MCP elicitation response');
  if (result.action !== 'accept' || request.params.mode === 'url') {
    return;
  }
  const content = result.content;
  if (!(content && typeof content === 'object' && !Array.isArray(content))) {
    throw new Error('Accepted MCP form elicitation content must be an object');
  }
  const schema = request.params.requestedSchema;
  const properties = schema.properties;
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(content, name)) {
      throw new Error(`Accepted MCP form elicitation content is missing required field "${name}"`);
    }
  }
  for (const [name, value] of Object.entries(content)) {
    if (!Object.hasOwn(properties, name)) {
      throw new Error(`Accepted MCP form elicitation content contains unknown field "${name}"`);
    }
    validatePrimitiveValue(name, value, properties[name]);
  }
}

function validatePrimitiveValue(name: string, value: unknown, schema: unknown): void {
  if (!(schema && typeof schema === 'object' && !Array.isArray(schema))) {
    throw new Error(`MCP form schema for "${name}" is invalid`);
  }
  const definition = schema as Record<string, unknown>;
  const type = definition['type'];
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`Accepted MCP form field "${name}" must be a string`);
    }
    validateStringConstraints(name, value, definition);
    return;
  }
  if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    ) {
      throw new Error(`Accepted MCP form field "${name}" must be a ${String(type)}`);
    }
    validateNumberConstraints(name, value, definition);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`Accepted MCP form field "${name}" must be a boolean`);
    }
    return;
  }
  if (type === 'array') {
    validateStringArray(name, value, definition);
    return;
  }
  throw new Error(`MCP form schema for "${name}" uses an unsupported type`);
}

function validateStringConstraints(
  name: string,
  value: string,
  definition: Record<string, unknown>
): void {
  const minLength = definition['minLength'];
  const maxLength = definition['maxLength'];
  if (typeof minLength === 'number' && value.length < minLength) {
    throw new Error(`Accepted MCP form field "${name}" is shorter than minLength`);
  }
  if (typeof maxLength === 'number' && value.length > maxLength) {
    throw new Error(`Accepted MCP form field "${name}" is longer than maxLength`);
  }
  const allowed = readAllowedStrings(definition);
  if (allowed && !allowed.has(value)) {
    throw new Error(`Accepted MCP form field "${name}" is not an allowed value`);
  }
  validateStringFormat(name, value, definition['format']);
}

function validateStringFormat(name: string, value: string, format: unknown): void {
  let valid: boolean;
  switch (format) {
    case undefined:
      return;
    case 'email':
      valid = isEmail(value);
      break;
    case 'uri':
      valid = isAbsoluteUri(value);
      break;
    case 'date':
      valid = isFullDate(value);
      break;
    case 'date-time':
      valid = isDateTime(value);
      break;
    default:
      throw new Error(`MCP form field "${name}" uses unsupported string format`);
  }
  if (!valid) {
    throw new Error(`Accepted MCP form field "${name}" does not match format "${format}"`);
  }
}

function isEmail(value: string): boolean {
  if (value.length > 254 || containsEmailControlOrSpace(value)) {
    return false;
  }
  const match =
    /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/u.exec(
      value
    );
  const local = match?.[1];
  const domain = match?.[2];
  return Boolean(local && domain && local.length <= 64 && domain.length <= 253);
}

function containsEmailControlOrSpace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function isFullDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isDateTime(value: string): boolean {
  if (!isFullDate(value.slice(0, 10))) {
    return false;
  }
  return /^[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
    value.slice(10)
  );
}

function validateNumberConstraints(
  name: string,
  value: number,
  definition: Record<string, unknown>
): void {
  const minimum = definition['minimum'];
  const maximum = definition['maximum'];
  if (typeof minimum === 'number' && value < minimum) {
    throw new Error(`Accepted MCP form field "${name}" is below minimum`);
  }
  if (typeof maximum === 'number' && value > maximum) {
    throw new Error(`Accepted MCP form field "${name}" is above maximum`);
  }
}

function validateStringArray(
  name: string,
  value: unknown,
  definition: Record<string, unknown>
): void {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`Accepted MCP form field "${name}" must be a string array`);
  }
  const minItems = definition['minItems'];
  const maxItems = definition['maxItems'];
  if (typeof minItems === 'number' && value.length < minItems) {
    throw new Error(`Accepted MCP form field "${name}" has too few items`);
  }
  if (typeof maxItems === 'number' && value.length > maxItems) {
    throw new Error(`Accepted MCP form field "${name}" has too many items`);
  }
  const items = definition['items'];
  const allowed =
    items && typeof items === 'object' && !Array.isArray(items)
      ? readAllowedStrings(items as Record<string, unknown>)
      : undefined;
  if (!(allowed && value.every((entry) => allowed.has(entry)))) {
    throw new Error(`Accepted MCP form field "${name}" contains an unsupported item`);
  }
}

function readAllowedStrings(definition: Record<string, unknown>): ReadonlySet<string> | undefined {
  const direct = definition['enum'];
  if (Array.isArray(direct) && direct.every((value) => typeof value === 'string')) {
    return new Set(direct);
  }
  const titled = definition['oneOf'] ?? definition['anyOf'];
  if (!Array.isArray(titled)) {
    return;
  }
  const values = titled.map((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)['const']
      : undefined
  );
  return values.every((value) => typeof value === 'string')
    ? new Set(values as string[])
    : undefined;
}

function assertBoundedJson(value: unknown, label: string): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(`${label} is not JSON serializable`);
  }
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MCP_CLIENT_INPUT_MAX_BYTES) {
    throw new Error(`${label} exceeds ${MCP_CLIENT_INPUT_MAX_BYTES} bytes`);
  }
}

function redactLogValue(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (active.has(value)) {
    return '[CIRCULAR]';
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactLogValue(entry, active));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      output[key] = SENSITIVE_LOG_KEY.test(key) ? REDACTED : redactLogValue(entry, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

export function sanitizeMcpServerLog(
  params: LoggingMessageNotification['params']
): SanitizedMcpServerLog {
  assertBoundedJson(params, 'MCP server log');
  return {
    data: redactLogValue(params.data),
    level: params.level,
    ...(params.logger === undefined ? {} : { remoteLogger: params.logger.slice(0, 256) }),
  };
}

function isAllowedLogLevel(level: LoggingLevel, minimum: LoggingLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}
