import type { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import type {
  McpConfiguredProtocol,
  McpConnectionState,
  McpNegotiatedStatus,
  McpStatusTransport,
} from './mcp-status.js';

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
export const McpHostErrorSchema: z.ZodType<McpHostError> = z.strictObject({
  category: McpStableErrorCategorySchema,
  code: z.string(),
  message: z.string(),
});

interface McpHostServerSnapshotBase {
  configuredProtocol: McpConfiguredProtocol;
  configuredServerId: ConfiguredMcpServerId;
  diagnostics?: readonly McpHostDiagnostic[];
  enabledTools?: readonly string[];
  generation: number;
  transport: McpStatusTransport;
}
export interface McpHostDiagnostic {
  message: string;
  stream: 'stderr';
  truncated: boolean;
}
export const MCP_HOST_DIAGNOSTIC_MAX_ENTRIES = 20;
type PendingMcpConnectionState = Exclude<McpConnectionState, 'connected' | 'error'>;
export type McpHostServerSnapshot = McpHostServerSnapshotBase &
  (
    | { state: PendingMcpConnectionState }
    | { error: McpHostError; state: Extract<McpConnectionState, 'error'> }
    | { negotiated: McpNegotiatedStatus; state: Extract<McpConnectionState, 'connected'> }
  );
export interface McpHostSnapshot {
  revision: number;
  servers: readonly McpHostServerSnapshot[];
}

const JsonObjectSchema = z.record(z.string(), z.json());
const RequestMetaSchema = JsonObjectSchema.optional();
const McpHostOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    _meta: RequestMetaSchema,
    configuredServerId: ConfiguredMcpServerIdSchema,
    cursor: z.string().optional(),
    type: z.literal('tools/list'),
  }),
  z.strictObject({
    _meta: RequestMetaSchema,
    arguments: JsonObjectSchema.optional(),
    configuredServerId: ConfiguredMcpServerIdSchema,
    task: z.strictObject({ ttl: z.number().optional() }).optional(),
    toolName: z.string().min(1),
    type: z.literal('tools/call'),
  }),
]);
export type McpHostOperation = z.output<typeof McpHostOperationSchema>;
export const parseMcpHostOperation = (value: unknown): McpHostOperation =>
  McpHostOperationSchema.parse(value);

const ReferenceIdSchema = z.uuid();
const CredentialReferenceSchema = z.strictObject({
  id: ReferenceIdSchema,
  store: z.literal('mcp-credentials'),
});
const AuthSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('oauth-user') }),
  z.strictObject({ credential: CredentialReferenceSchema, type: z.literal('bearer') }),
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
    auth: AuthSchema,
    configuredProtocol: McpConfiguredProtocolSchema,
    configuredServerId: ConfiguredMcpServerIdSchema,
    enabledTools: z.array(z.string()).optional(),
    startup: McpStartupPolicySchema,
    transport: TransportSchema,
  })
  .refine(
    ({ configuredProtocol, transport }) =>
      transport.type !== 'sse' || configuredProtocol === 'legacy',
    { message: 'SSE transport requires legacy protocol', path: ['configuredProtocol'] }
  );
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
  action: z.enum(['connect', 'retry', 'cancel']),
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
type SdkListToolsResult = z.output<typeof ListToolsResultSchema>;
type SdkCallToolResult = z.output<typeof CallToolResultSchema>;
export type McpHostOperationResult =
  | { readonly result: BrowserSafe<SdkListToolsResult>; readonly type: 'tools/list' }
  | { readonly result: BrowserSafe<SdkCallToolResult>; readonly type: 'tools/call' };

export interface McpHostWatchFilter {
  configuredServerIds?: readonly ConfiguredMcpServerId[];
}
export interface McpHostWatchEvent {
  revision: number;
  servers: readonly McpHostServerSnapshot[];
}
export interface McpHostInvokeOptions {
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
