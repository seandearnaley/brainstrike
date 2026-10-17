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
import { Effect, Schema, SchemaIssue } from 'effect';
import type { z } from 'zod';
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
export const MCP_CONFIGURED_SERVER_ID_MAX_LENGTH = 128;
const RESERVED_CONFIGURED_SERVER_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const UNICODE_CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;
export const ConfiguredMcpServerIdSchema = Schema.String.check(
  Schema.isMinCodePoints(1, { message: 'must not be empty' })
)
  .check(
    Schema.makeFilter((value) =>
      [...value].length <= MCP_CONFIGURED_SERVER_ID_MAX_LENGTH
        ? undefined
        : {
            issue: `must contain at most ${MCP_CONFIGURED_SERVER_ID_MAX_LENGTH} Unicode code points`,
            path: [],
          }
    )
  )
  .check(
    Schema.makeFilter((value) =>
      value.trim() === value ? undefined : { issue: 'invalid surrounding whitespace', path: [] }
    )
  )
  .check(
    Schema.makeFilter((value) =>
      RESERVED_CONFIGURED_SERVER_IDS.has(value)
        ? { issue: 'reserved server name', path: [] }
        : undefined
    )
  )
  .check(
    Schema.makeFilter((value) =>
      UNICODE_CONTROL_OR_FORMAT_PATTERN.test(value)
        ? { issue: 'must not contain a Unicode control or format character', path: [] }
        : undefined
    )
  )
  .pipe(Schema.brand('ConfiguredMcpServerId'));
export type ConfiguredMcpServerId = typeof ConfiguredMcpServerIdSchema.Type;
export function parseConfiguredMcpServerId(value: unknown): ConfiguredMcpServerId {
  const result = Schema.decodeUnknownResult(ConfiguredMcpServerIdSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  if (!(result._tag === 'Success')) {
    const diagnostics = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue)
      .issues.map(({ message }) => message)
      .join('; ');
    throw new Error(`Invalid configured MCP server id: ${diagnostics}`);
  }
  return result.success;
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
export const McpStableErrorCategorySchema = Schema.Literals(MCP_STABLE_ERROR_CATEGORIES);
export type McpHostJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly McpHostJsonValue[]
  | {
      readonly [key: string]: McpHostJsonValue;
    };
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
  | {
      type: 'none';
    }
  | McpHostBearerAuthSnapshot
  | McpHostOAuthAuthSnapshot;
export const McpHostErrorSchema: Schema.ConstraintDecoder<McpHostError> = Schema.Struct({
  category: McpStableErrorCategorySchema,
  code: Schema.String,
  message: Schema.String,
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
    | {
        state: PendingMcpConnectionState;
      }
    | {
        error: McpHostError;
        state: Extract<McpConnectionState, 'error'>;
      }
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
type McpHostOAuthSnapshot = Extract<
  McpHostAuthSnapshot,
  {
    type: 'oauth-user';
  }
>;
function resolveOAuthErrorActions(
  server: Extract<
    McpHostServerSnapshot,
    {
      state: 'error';
    }
  >,
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
const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
const RequestMetaSchema = Schema.optional(JsonObjectSchema);
const CursorSchema = Schema.optional(Schema.String);
const ServerOperationBase = {
  _meta: RequestMetaSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
};
export const McpResourceUriSchema = Schema.String.check(Schema.isMinCodePoints(1)).check(
  Schema.makeFilter((value) =>
    value.trim() === value ? undefined : { issue: 'invalid surrounding whitespace', path: [] }
  )
);
const McpHostOperationSchema = Schema.Union(
  [
    Schema.Struct({
      ...ServerOperationBase,
      cursor: CursorSchema,
      type: Schema.Literal('tools/list'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      arguments: Schema.optional(JsonObjectSchema),
      task: Schema.optional(Schema.Struct({ ttl: Schema.optional(Schema.Finite) })),
      toolName: Schema.String.check(Schema.isMinCodePoints(1)),
      type: Schema.Literal('tools/call'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      cursor: CursorSchema,
      type: Schema.Literal('resources/list'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      cursor: CursorSchema,
      type: Schema.Literal('resources/templates/list'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      type: Schema.Literal('resources/read'),
      uri: McpResourceUriSchema,
    }),
    Schema.Struct({
      ...ServerOperationBase,
      cursor: CursorSchema,
      type: Schema.Literal('prompts/list'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      name: Schema.String.check(Schema.isMinCodePoints(1)),
      type: Schema.Literal('prompts/get'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      argument: Schema.Struct({
        name: Schema.String.check(Schema.isMinCodePoints(1)),
        value: Schema.String,
      }),
      context: Schema.optional(
        Schema.Struct({ arguments: Schema.Record(Schema.String, Schema.String) })
      ),
      ref: Schema.Union(
        [
          Schema.Struct({
            name: Schema.String.check(Schema.isMinCodePoints(1)),
            type: Schema.Literal('ref/prompt'),
          }),
          Schema.Struct({ type: Schema.Literal('ref/resource'), uri: McpResourceUriSchema }),
        ],
        { mode: 'oneOf' }
      ),
      type: Schema.Literal('completion/complete'),
    }),
    Schema.Struct({
      ...ServerOperationBase,
      type: Schema.Literal('resources/subscribe'),
      uri: McpResourceUriSchema,
    }),
    Schema.Struct({
      ...ServerOperationBase,
      type: Schema.Literal('resources/unsubscribe'),
      uri: McpResourceUriSchema,
    }),
  ],
  { mode: 'oneOf' }
);
export type McpHostOperation = (typeof McpHostOperationSchema)['Type'];
export const parseMcpHostOperation = (value: unknown): McpHostOperation =>
  Schema.decodeUnknownSync(McpHostOperationSchema, { errors: 'all', onExcessProperty: 'error' })(
    value
  );
const ReferenceIdSchema = Schema.String.check(Schema.isUUID());
export const McpCredentialReferenceSchema = Schema.Struct({
  id: ReferenceIdSchema,
  store: Schema.Literal('mcp-credentials'),
});
export const McpOAuthScopeSchema = Schema.String.check(
  Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]+$/u, { message: 'must be one RFC 6749 scope token' })
);
export const McpOAuthScopesSchema = Schema.mutable(Schema.Array(McpOAuthScopeSchema))
  .check(Schema.isMinLength(1))
  .check(
    Schema.makeFilter((scopes) =>
      new Set(scopes).size === scopes.length
        ? undefined
        : { issue: 'must not contain duplicates', path: [] }
    )
  );
export const McpConfiguredAuthSchema = Schema.Union(
  [
    Schema.Struct({ type: Schema.Literal('none') }),
    Schema.Struct({
      scopes: Schema.optional(McpOAuthScopesSchema),
      type: Schema.Literal('oauth-user'),
    }),
    Schema.Struct({ credential: McpCredentialReferenceSchema, type: Schema.Literal('bearer') }),
  ],
  { mode: 'oneOf' }
);
export const McpConfiguredProtocolSchema = Schema.Literals([
  'legacy',
  'auto',
  '2026-07-28',
]) satisfies Schema.ConstraintDecoder<McpConfiguredProtocol>;
export const McpStatusTransportSchema = Schema.Literals([
  'stdio',
  'streamable-http',
  'sse',
]) satisfies Schema.ConstraintDecoder<McpStatusTransport>;
const TransportSchema = Schema.Struct({
  configRef: ReferenceIdSchema,
  type: McpStatusTransportSchema,
});
export const McpStartupPolicySchema = Schema.Literals(['automatic', 'authentication-required'])
  .annotate({ default: 'automatic' })
  .pipe(Schema.withDecodingDefault(Effect.succeed('automatic')));
export type McpStartupPolicy = (typeof McpStartupPolicySchema)['Type'];
const McpConfiguredServerSchema = Schema.Struct({
  auth: McpConfiguredAuthSchema,
  configuredProtocol: McpConfiguredProtocolSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
  enabledTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  extensions: Schema.optional(McpExtensionEnablementSchema),
  startup: McpStartupPolicySchema,
  transport: TransportSchema,
})
  .check(
    Schema.makeFilter(({ configuredProtocol, transport }) =>
      transport.type !== 'sse' || configuredProtocol === 'legacy'
        ? undefined
        : {
            issue: 'SSE transport requires legacy protocol',
            path:
              { message: 'SSE transport requires legacy protocol', path: ['configuredProtocol'] }
                .path ?? [],
          }
    )
  )
  .check(
    Schema.makeFilter(({ auth, startup }) =>
      auth.type !== 'oauth-user' || startup === 'authentication-required'
        ? undefined
        : {
            issue: 'OAuth user authentication requires authentication-required startup',
            path:
              {
                message: 'OAuth user authentication requires authentication-required startup',
                path: ['startup'],
              }.path ?? [],
          }
    )
  )
  .check(
    Schema.makeFilter(({ auth, transport }) =>
      auth.type !== 'oauth-user' || transport.type !== 'stdio'
        ? undefined
        : {
            issue: 'OAuth user authentication requires an HTTP transport',
            path:
              {
                message: 'OAuth user authentication requires an HTTP transport',
                path: ['auth'],
              }.path ?? [],
          }
    )
  );
const McpHostConfigSchema = Schema.Struct({
  servers: Schema.mutable(Schema.Array(McpConfiguredServerSchema)).check(
    Schema.makeFilter((servers) =>
      new Set(servers.map(({ configuredServerId }) => configuredServerId)).size === servers.length
        ? undefined
        : { issue: 'duplicate configured server id', path: [] }
    )
  ),
});
export type McpHostConfig = (typeof McpHostConfigSchema)['Type'];
export const parseMcpHostConfig = (value: unknown): McpHostConfig =>
  Schema.decodeUnknownSync(McpHostConfigSchema, { errors: 'all', onExcessProperty: 'error' })(
    value
  );
export const McpHostControlRequestSchema = Schema.Struct({
  action: Schema.Literals(['connect', 'retry', 'cancel', 'disconnect', 'reauthorize']),
  configuredServerId: ConfiguredMcpServerIdSchema,
});
export type McpHostControlRequest = (typeof McpHostControlRequestSchema)['Type'];
export const parseMcpHostControlRequest = (value: unknown): McpHostControlRequest =>
  Schema.decodeUnknownSync(McpHostControlRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
type BrowserSafe<T> = unknown extends T
  ? McpHostJsonValue
  : T extends (...args: never[]) => unknown
    ? never
    : T extends string | number | boolean | null
      ? T
      : T extends readonly (infer Item)[]
        ? readonly BrowserSafe<Item>[]
        : T extends object
          ? {
              readonly [Key in keyof T]: BrowserSafe<T[Key]>;
            }
          : never;
export type McpHostOperationResult =
  | {
      readonly result: BrowserSafe<SdkListToolsResult>;
      readonly type: 'tools/list';
    }
  | {
      readonly result: BrowserSafe<SdkCallToolResult>;
      readonly type: 'tools/call';
    }
  | {
      readonly result: BrowserSafe<SdkListResourcesResult>;
      readonly type: 'resources/list';
    }
  | {
      readonly result: BrowserSafe<SdkListResourceTemplatesResult>;
      readonly type: 'resources/templates/list';
    }
  | {
      readonly result: BrowserSafe<SdkReadResourceResult>;
      readonly type: 'resources/read';
    }
  | {
      readonly result: BrowserSafe<SdkListPromptsResult>;
      readonly type: 'prompts/list';
    }
  | {
      readonly result: BrowserSafe<SdkGetPromptResult>;
      readonly type: 'prompts/get';
    }
  | {
      readonly result: BrowserSafe<SdkCompleteResult>;
      readonly type: 'completion/complete';
    }
  | {
      readonly result: BrowserSafe<SdkEmptyResult>;
      readonly type: 'resources/subscribe';
    }
  | {
      readonly result: BrowserSafe<SdkEmptyResult>;
      readonly type: 'resources/unsubscribe';
    };
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
/**
 * Core's ownership of the durable tasks its runs bound, across a host restart
 * (BST-1930 c3). A recovered task's input goes to Core, never a local listener,
 * and its earlier answers are read from Core's committed log.
 */
export interface McpHostTaskOwner {
  /**
   * The committed outcome of the latest answer Core accepted for this task
   * input: `acknowledged` (the server's ack), `unknown` (sent, never proven),
   * or undefined when no answer was ever accepted.
   */
  inputOutcome(handle: McpTaskHandle, inputKey: string): 'acknowledged' | 'unknown' | undefined;
  /** Core's execution for a task its run bound; undefined when no committed binding owns it. */
  recover(handle: McpTaskHandle): McpHostExecution | undefined;
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
