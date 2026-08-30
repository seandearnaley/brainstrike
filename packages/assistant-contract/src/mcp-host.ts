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

function isConfiguredIdCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint > 31 && (codePoint < 127 || codePoint > 159);
}

export const ConfiguredMcpServerIdSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => value.trim() === value, 'invalid surrounding whitespace')
  .refine((value) => value !== '__proto__', 'reserved server name')
  .refine((value) => [...value].every(isConfiguredIdCharacter), 'invalid control character')
  .transform((value) => value as ConfiguredMcpServerId);

export function parseConfiguredMcpServerId(value: unknown): ConfiguredMcpServerId {
  const result = ConfiguredMcpServerIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid configured MCP server id');
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

interface McpHostServerSnapshotBase {
  configuredProtocol: McpConfiguredProtocol;
  configuredServerId: ConfiguredMcpServerId;
  generation: number;
  transport: McpStatusTransport;
}
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
const TransportSchema = z.strictObject({
  configRef: ReferenceIdSchema,
  type: z.enum(['stdio', 'streamable-http', 'sse']),
});
const McpHostConfigSchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        auth: AuthSchema,
        configuredProtocol: z.enum(['legacy', 'auto', '2026-07-28']),
        configuredServerId: ConfiguredMcpServerIdSchema,
        enabledTools: z.array(z.string()).optional(),
        transport: TransportSchema,
      })
    )
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

type BrowserSafe<T> = unknown extends T
  ? McpHostJsonValue
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
  | (BrowserSafe<SdkListToolsResult> & { readonly type: 'tools/list' })
  | (BrowserSafe<SdkCallToolResult> & { readonly type: 'tools/call' });

export interface McpHostWatchFilter {
  configuredServerIds?: readonly ConfiguredMcpServerId[];
}
export interface McpHostWatchEvent {
  revision: number;
  servers: readonly McpHostServerSnapshot[];
}
type McpHostCloseCounter =
  | 'callbacksClosed'
  | 'childProcessesClosed'
  | 'clientsClosed'
  | 'loopbackPortsClosed'
  | 'probesClosed'
  | 'requestsSettled'
  | 'subscriptionsClosed';
export type McpHostCloseReport = Readonly<Record<McpHostCloseCounter, number>>;
export interface McpHostPort {
  close(): Promise<McpHostCloseReport>;
  invoke(operation: McpHostOperation): Promise<McpHostOperationResult>;
  replaceConfig(config: McpHostConfig): Promise<McpHostSnapshot>;
  snapshot(): McpHostSnapshot;
  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void;
}

export { MCP_CONNECTION_STATES, type McpConnectionState } from './mcp-status.js';
