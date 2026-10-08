import type {
  CallToolResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod';
import type {
  McpElicitationPresentationWire,
  McpElicitationSettlement,
} from './mcp-elicitation.js';
import { type McpExtensionEnablement, McpExtensionEnablementSchema } from './mcp-extensions.js';
import type {
  McpConfiguredProtocol,
  McpConnectionState,
  McpNegotiatedStatus,
  McpStatusTransport,
} from './mcp-status.js';
import type { McpTaskHandle } from './mcp-task-presentation.js';

export type ConfiguredMcpServerId = string & {
  readonly __configuredMcpServerId: 'ConfiguredMcpServerId';
};

export const MCP_CONFIGURED_SERVER_ID_MAX_LENGTH = 128;
const RESERVED_CONFIGURED_SERVER_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const UNICODE_CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;

export const ConfiguredMcpServerIdSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine(
    (value) => [...value].length <= MCP_CONFIGURED_SERVER_ID_MAX_LENGTH,
    `must contain at most ${MCP_CONFIGURED_SERVER_ID_MAX_LENGTH} Unicode code points`
  )
  .refine((value) => value.trim() === value, 'invalid surrounding whitespace')
  .refine((value) => !RESERVED_CONFIGURED_SERVER_IDS.has(value), 'reserved server name')
  .refine(
    (value) => !UNICODE_CONTROL_OR_FORMAT_PATTERN.test(value),
    'must not contain a Unicode control or format character'
  )
  .transform((value) => value as ConfiguredMcpServerId);

export function parseConfiguredMcpServerId(value: unknown): ConfiguredMcpServerId {
  const result = ConfiguredMcpServerIdSchema.safeParse(value);
  if (!result.success) {
    const diagnostics = result.error.issues.map(({ message }) => message).join('; ');
    throw new Error(`Invalid configured MCP server id: ${diagnostics}`);
  }
  return result.data;
}

export const MCP_STABLE_ERROR_CATEGORIES = [
  'authentication',
  'authorization',
  'configuration',
  'connection',
  'generation-retired',
  'host-closed',
  'operation',
  'protocol',
  'transport',
] as const;
export type McpStableErrorCategory = (typeof MCP_STABLE_ERROR_CATEGORIES)[number];
export const McpStableErrorCategorySchema = z.enum(MCP_STABLE_ERROR_CATEGORIES);
export type McpHostJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly McpHostJsonValue[]
  | { readonly [key: string]: McpHostJsonValue };

export interface McpHostError {
  category: McpStableErrorCategory;
  code: string;
  message: string;
}
export interface McpHostOAuthAuthSnapshot {
  authorizationServer?: string;
  credentialState: 'missing' | 'stored' | 'unreadable';
  grantedScopes: readonly string[];
  lastSuccessfulConnectionAt?: number;
  requestedScopes: readonly string[];
  resourceUrl: string;
  type: 'oauth-user';
}
export interface McpHostBearerAuthSnapshot {
  credentialState: 'malformed' | 'missing' | 'stored' | 'unreadable';
  type: 'bearer';
}
export type McpHostAuthSnapshot =
  | { type: 'none' }
  | McpHostBearerAuthSnapshot
  | McpHostOAuthAuthSnapshot;
export const McpHostErrorSchema: z.ZodType<McpHostError> = z.strictObject({
  category: McpStableErrorCategorySchema,
  code: z.string(),
  message: z.string(),
});

export const MCP_CORE_SERVER_PROJECTION = Object.freeze({
  completion: Object.freeze({
    operations: Object.freeze(['completion/complete'] as const),
    visibility: 'user-or-authorized-assistant' as const,
  }),
  eagerModelContext: false,
  prompts: Object.freeze({
    control: 'user' as const,
    operations: Object.freeze(['prompts/list', 'prompts/get'] as const),
    visibility: 'user-or-authorized-assistant' as const,
  }),
  resources: Object.freeze({
    control: 'application' as const,
    operations: Object.freeze([
      'resources/list',
      'resources/templates/list',
      'resources/read',
    ] as const),
    visibility: 'user-or-authorized-assistant' as const,
  }),
});

interface McpHostServerSnapshotBase {
  auth?: McpHostAuthSnapshot;
  configuredProtocol: McpConfiguredProtocol;
  configuredServerId: ConfiguredMcpServerId;
  diagnostics?: readonly McpHostDiagnostic[];
  enabledTools?: readonly string[];
  /** Effective registered-extension state for this generation (BST-1604). */
  extensions?: McpExtensionEnablement;
  generation: number;
  transport: McpStatusTransport;
}
export interface McpHostDiagnostic {
  message: string;
  stream: 'stderr';
  truncated: boolean;
}
export const MCP_HOST_DIAGNOSTIC_MAX_ENTRIES = 20;
export const MCP_HOST_CATALOG_SECTIONS = [
  'prompts',
  'resources',
  'resourceTemplates',
  'subscription',
  'tools',
] as const;
export type McpHostCatalogSection = (typeof MCP_HOST_CATALOG_SECTIONS)[number];
export type McpHostCatalogErrors = {
  readonly [Section in McpHostCatalogSection]?: McpHostError | undefined;
};
export interface McpHostServerFeatures {
  completion: boolean;
  promptListChanged: boolean;
  prompts: boolean;
  resourceListChanged: boolean;
  resourceSubscriptions: boolean;
  resources: boolean;
  toolListChanged: boolean;
  tools: boolean;
}
export interface McpHostSubscriptionFilter {
  promptsListChanged?: boolean | undefined;
  resourceSubscriptions?: readonly string[] | undefined;
  resourcesListChanged?: boolean | undefined;
  toolsListChanged?: boolean | undefined;
}
export interface McpHostSubscriptionStatus {
  honoredFilter?: McpHostSubscriptionFilter | undefined;
  mode: 'legacy-unsolicited' | 'modern-listen' | 'none';
  state: 'closed' | 'listening' | 'retrying' | 'unsupported';
}

type SdkListToolsResult = z.output<typeof ListToolsResultSchema>;
type SdkCallToolResult = z.output<typeof CallToolResultSchema>;
type SdkListResourcesResult = z.output<typeof ListResourcesResultSchema>;
type SdkListResourceTemplatesResult = z.output<typeof ListResourceTemplatesResultSchema>;
type SdkReadResourceResult = z.output<typeof ReadResourceResultSchema>;
type SdkListPromptsResult = z.output<typeof ListPromptsResultSchema>;
type SdkGetPromptResult = z.output<typeof GetPromptResultSchema>;
type SdkCompleteResult = z.output<typeof CompleteResultSchema>;
type SdkEmptyResult = z.output<typeof EmptyResultSchema>;

export interface McpHostCatalog {
  errors: McpHostCatalogErrors;
  features: McpHostServerFeatures;
  prompts?: BrowserSafe<SdkListPromptsResult> | undefined;
  resources?: BrowserSafe<SdkListResourcesResult> | undefined;
  resourceTemplates?: BrowserSafe<SdkListResourceTemplatesResult> | undefined;
  subscription: McpHostSubscriptionStatus;
  tools?: BrowserSafe<SdkListToolsResult> | undefined;
}
type PendingMcpConnectionState = Exclude<McpConnectionState, 'connected' | 'error'>;
export type McpHostServerSnapshot = McpHostServerSnapshotBase &
  (
    | { state: PendingMcpConnectionState }
    | { error: McpHostError; state: Extract<McpConnectionState, 'error'> }
    | {
        catalog?: McpHostCatalog | undefined;
        negotiated: McpNegotiatedStatus;
        state: Extract<McpConnectionState, 'connected'>;
      }
  );
export interface McpHostSnapshot {
  revision: number;
  servers: readonly McpHostServerSnapshot[];
}

type McpHostControlAction = McpHostControlRequest['action'];
type McpHostOAuthSnapshot = Extract<McpHostAuthSnapshot, { type: 'oauth-user' }>;

function resolveOAuthErrorActions(
  server: Extract<McpHostServerSnapshot, { state: 'error' }>,
  auth: McpHostOAuthSnapshot
): readonly McpHostControlAction[] {
  const credentialsStored = auth.credentialState === 'stored';
  if (server.error.category === 'authentication' || server.error.category === 'authorization') {
    return credentialsStored ? ['disconnect', 'reauthorize'] : ['reauthorize'];
  }
  return credentialsStored ? ['retry', 'disconnect'] : ['retry'];
}

function resolveOAuthControlActions(
  server: McpHostServerSnapshot,
  auth: McpHostOAuthSnapshot
): readonly McpHostControlAction[] {
  if (auth.credentialState === 'unreadable') {
    return ['disconnect'];
  }
  if (server.state === 'connected') {
    return ['disconnect', 'reauthorize'];
  }
  if (server.state === 'error') {
    return resolveOAuthErrorActions(server, auth);
  }
  if (server.state === 'authentication-required' || server.state === 'disconnected') {
    return auth.credentialState === 'stored' ? ['connect', 'disconnect'] : ['connect'];
  }
  return [];
}

export function resolveMcpHostControlActions(
  server: McpHostServerSnapshot
): readonly McpHostControlAction[] {
  if (server.state === 'connecting' || server.state === 'authorizing') {
    return ['cancel'];
  }
  if (server.auth?.type === 'oauth-user') {
    return resolveOAuthControlActions(server, server.auth);
  }
  if (server.state === 'error') {
    return ['retry'];
  }
  if (server.state === 'authentication-required' || server.state === 'disconnected') {
    return ['connect'];
  }
  return [];
}

const JsonObjectSchema = z.record(z.string(), z.json());
const RequestMetaSchema = JsonObjectSchema.optional();
const CursorSchema = z.string().optional();
const ServerOperationBase = {
  _meta: RequestMetaSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
};
export const McpResourceUriSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'invalid surrounding whitespace');
const McpHostOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...ServerOperationBase,
    cursor: CursorSchema,
    type: z.literal('tools/list'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    arguments: JsonObjectSchema.optional(),
    task: z.strictObject({ ttl: z.number().optional() }).optional(),
    toolName: z.string().min(1),
    type: z.literal('tools/call'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    cursor: CursorSchema,
    type: z.literal('resources/list'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    cursor: CursorSchema,
    type: z.literal('resources/templates/list'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    type: z.literal('resources/read'),
    uri: McpResourceUriSchema,
  }),
  z.strictObject({
    ...ServerOperationBase,
    cursor: CursorSchema,
    type: z.literal('prompts/list'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    arguments: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1),
    type: z.literal('prompts/get'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    argument: z.strictObject({ name: z.string().min(1), value: z.string() }),
    context: z.strictObject({ arguments: z.record(z.string(), z.string()) }).optional(),
    ref: z.discriminatedUnion('type', [
      z.strictObject({ name: z.string().min(1), type: z.literal('ref/prompt') }),
      z.strictObject({ type: z.literal('ref/resource'), uri: McpResourceUriSchema }),
    ]),
    type: z.literal('completion/complete'),
  }),
  z.strictObject({
    ...ServerOperationBase,
    type: z.literal('resources/subscribe'),
    uri: McpResourceUriSchema,
  }),
  z.strictObject({
    ...ServerOperationBase,
    type: z.literal('resources/unsubscribe'),
    uri: McpResourceUriSchema,
  }),
]);
export type McpHostOperation = z.output<typeof McpHostOperationSchema>;
export const parseMcpHostOperation = (value: unknown): McpHostOperation =>
  McpHostOperationSchema.parse(value);

const ReferenceIdSchema = z.uuid();
export const McpCredentialReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  store: z.literal('mcp-credentials'),
});
export const McpOAuthScopeSchema = z
  .string()
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u, 'must be one RFC 6749 scope token');
export const McpOAuthScopesSchema = z
  .array(McpOAuthScopeSchema)
  .min(1)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'must not contain duplicates');
export const McpConfiguredAuthSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ scopes: McpOAuthScopesSchema.optional(), type: z.literal('oauth-user') }),
  z.strictObject({ credential: McpCredentialReferenceSchema, type: z.literal('bearer') }),
]);
export const McpConfiguredProtocolSchema = z.enum([
  'legacy',
  'auto',
  '2026-07-28',
]) satisfies z.ZodType<McpConfiguredProtocol>;
export const McpStatusTransportSchema = z.enum([
  'stdio',
  'streamable-http',
  'sse',
]) satisfies z.ZodType<McpStatusTransport>;
const TransportSchema = z.strictObject({
  configRef: ReferenceIdSchema,
  type: McpStatusTransportSchema,
});
export const McpStartupPolicySchema = z
  .enum(['automatic', 'authentication-required'])
  .default('automatic');
export type McpStartupPolicy = z.output<typeof McpStartupPolicySchema>;
const McpConfiguredServerSchema = z
  .strictObject({
    auth: McpConfiguredAuthSchema,
    configuredProtocol: McpConfiguredProtocolSchema,
    configuredServerId: ConfiguredMcpServerIdSchema,
    enabledTools: z.array(z.string()).optional(),
    extensions: McpExtensionEnablementSchema.optional(),
    startup: McpStartupPolicySchema,
    transport: TransportSchema,
  })
  .refine(
    ({ configuredProtocol, transport }) =>
      transport.type !== 'sse' || configuredProtocol === 'legacy',
    { message: 'SSE transport requires legacy protocol', path: ['configuredProtocol'] }
  )
  .refine(
    ({ auth, startup }) => auth.type !== 'oauth-user' || startup === 'authentication-required',
    {
      message: 'OAuth user authentication requires authentication-required startup',
      path: ['startup'],
    }
  )
  .refine(({ auth, transport }) => auth.type !== 'oauth-user' || transport.type !== 'stdio', {
    message: 'OAuth user authentication requires an HTTP transport',
    path: ['auth'],
  });
const McpHostConfigSchema = z.strictObject({
  servers: z
    .array(McpConfiguredServerSchema)
    .refine(
      (servers) =>
        new Set(servers.map(({ configuredServerId }) => configuredServerId)).size ===
        servers.length,
      'duplicate configured server id'
    ),
});
export type McpHostConfig = z.output<typeof McpHostConfigSchema>;
export const parseMcpHostConfig = (value: unknown): McpHostConfig =>
  McpHostConfigSchema.parse(value);

export const McpHostControlRequestSchema = z.strictObject({
  action: z.enum(['connect', 'retry', 'cancel', 'disconnect', 'reauthorize']),
  configuredServerId: ConfiguredMcpServerIdSchema,
});
export type McpHostControlRequest = z.output<typeof McpHostControlRequestSchema>;
export const parseMcpHostControlRequest = (value: unknown): McpHostControlRequest =>
  McpHostControlRequestSchema.parse(value);

type BrowserSafe<T> = unknown extends T
  ? McpHostJsonValue
  : T extends (...args: never[]) => unknown
    ? never
    : T extends string | number | boolean | null
      ? T
      : T extends readonly (infer Item)[]
        ? readonly BrowserSafe<Item>[]
        : T extends object
          ? { readonly [Key in keyof T]: BrowserSafe<T[Key]> }
          : never;
export type McpHostOperationResult =
  | { readonly result: BrowserSafe<SdkListToolsResult>; readonly type: 'tools/list' }
  | { readonly result: BrowserSafe<SdkCallToolResult>; readonly type: 'tools/call' }
  | { readonly result: BrowserSafe<SdkListResourcesResult>; readonly type: 'resources/list' }
  | {
      readonly result: BrowserSafe<SdkListResourceTemplatesResult>;
      readonly type: 'resources/templates/list';
    }
  | { readonly result: BrowserSafe<SdkReadResourceResult>; readonly type: 'resources/read' }
  | { readonly result: BrowserSafe<SdkListPromptsResult>; readonly type: 'prompts/list' }
  | { readonly result: BrowserSafe<SdkGetPromptResult>; readonly type: 'prompts/get' }
  | { readonly result: BrowserSafe<SdkCompleteResult>; readonly type: 'completion/complete' }
  | { readonly result: BrowserSafe<SdkEmptyResult>; readonly type: 'resources/subscribe' }
  | { readonly result: BrowserSafe<SdkEmptyResult>; readonly type: 'resources/unsubscribe' };

export interface McpHostWatchFilter {
  configuredServerIds?: readonly ConfiguredMcpServerId[];
}
export interface McpHostWatchEvent {
  revision: number;
  servers: readonly McpHostServerSnapshot[];
}
/**
 * The agent host's run-scoped MCP execution capability, mirrored structurally
 * (the host's `HostMcpExecution`) so MCP leaf code can carry it without
 * depending on the host package. Core commits every fact; the leaf only
 * validates and delivers.
 */
export interface McpHostInputCapability {
  assertCurrent(): Promise<void>;
  readonly presentation: McpElicitationPresentationWire;
  settle(answer: McpElicitationSettlement): Promise<'local-finalized' | 'remote-acknowledged'>;
  readonly signal: AbortSignal;
  /** Pure: never resolves, finalizes or sends an answer. */
  validate(answer: McpElicitationSettlement): Promise<void>;
}
export interface McpHostTaskCapability {
  assertCurrent(): Promise<void>;
  readonly handle: McpTaskHandle;
}
export interface McpHostExecution {
  /** Joins Core's binding commit before the task's input can be presented. */
  bindTask(task: McpHostTaskCapability): Promise<void>;
  /** Joins Core's request commit before any client is notified. */
  requestInput(input: McpHostInputCapability): Promise<void>;
  /** The host thread whose run admitted this call; its deletion erases the call's task rows. */
  readonly threadId: string;
}
export interface McpHostInvokeOptions {
  /** The admitting host tool call's capability. It never reaches the server. */
  execution?: McpHostExecution;
  onProgress?: (progress: McpHostProgress) => void;
  signal?: AbortSignal;
}
export interface McpHostProgress {
  message?: string | undefined;
  progress: number;
  total?: number | undefined;
}
type McpHostCloseCounter =
  | 'callbacksClosed'
  | 'childProcessesClosed'
  | 'clientsClosed'
  | 'loopbackPortsClosed'
  | 'probesClosed'
  | 'requestsSettled'
  | 'subscriptionsClosed';
export type McpHostCloseReport = Readonly<Record<McpHostCloseCounter, number>> & {
  readonly failures: readonly McpHostError[];
};
export interface McpHostPort {
  close(): Promise<McpHostCloseReport>;
  control(request: McpHostControlRequest): Promise<McpHostServerSnapshot>;
  invoke(
    operation: McpHostOperation,
    options?: McpHostInvokeOptions
  ): Promise<McpHostOperationResult>;
  replaceConfig(config: McpHostConfig): Promise<McpHostSnapshot>;
  snapshot(): McpHostSnapshot;
  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void;
}

export { MCP_CONNECTION_STATES, type McpConnectionState } from './mcp-status.js';
