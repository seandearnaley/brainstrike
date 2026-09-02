import { z } from 'zod';

/**
 * Renderer ↔ desktop-main contract for production MCP Apps (BST-1572
 * enablement). The renderer owns the sandbox, provenance, frame bridge, and
 * the tool-call authority's approval state; the main process owns admission
 * (prepare / execute / release against the live assistant run) and resource
 * reads. Channel names are the single source of truth for preload and IPC.
 */
export const MCP_APPS_IPC_CHANNELS = Object.freeze({
  execute: 'mcp:apps:execute',
  prepare: 'mcp:apps:prepare',
  release: 'mcp:apps:release',
} as const);

export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APPS_PREPARATION_ID_MAX_LENGTH = 256;

const IdentifierSchema = z.string().min(1).max(512);
const PreparationIdSchema = z.string().min(1).max(MCP_APPS_PREPARATION_ID_MAX_LENGTH);
const JsonObjectSchema = z.record(z.string(), z.json());

/** Where an app came from: the same-server tool and resource that own it. */
export const McpAppOriginSchema = z.strictObject({
  mimeType: z.literal(MCP_APPS_MIME_TYPE),
  resourceUri: z.string().min(1).max(2048).startsWith('ui://'),
  serverId: IdentifierSchema,
  toolName: IdentifierSchema,
});
export type McpAppOrigin = z.infer<typeof McpAppOriginSchema>;

export const McpAppPrepareRequestSchema = z.strictObject({
  arguments: JsonObjectSchema,
  origin: McpAppOriginSchema,
  preparationId: PreparationIdSchema,
  /** The tool the app is calling; may differ from the tool that opened it. */
  toolName: IdentifierSchema,
});
export type McpAppPrepareRequest = z.infer<typeof McpAppPrepareRequestSchema>;

export const McpAppPrepareResultSchema = z.strictObject({
  decision: z.enum(['allow', 'ask']),
  riskCategory: z.string().min(1).max(128),
});
export type McpAppPrepareResult = z.infer<typeof McpAppPrepareResultSchema>;

export const McpAppExecuteRequestSchema = z.strictObject({ preparationId: PreparationIdSchema });
export type McpAppExecuteRequest = z.infer<typeof McpAppExecuteRequestSchema>;

export const McpAppExecuteResultSchema = z.strictObject({ result: z.json() });
export type McpAppExecuteResult = z.infer<typeof McpAppExecuteResultSchema>;

export const McpAppReleaseRequestSchema = McpAppExecuteRequestSchema;
export type McpAppReleaseRequest = z.infer<typeof McpAppReleaseRequestSchema>;

/**
 * The raw domain result a tool call persists when the tool definition carried
 * `_meta.ui.resourceUri`. The thread correlates an app mount to the tool call
 * through this marker; `result` is the ordinary tool result the model saw.
 */
export const MCP_APP_TOOL_RESULT_KIND = 'mcp-app';

export const McpAppToolInvocationResultSchema = z.strictObject({
  app: McpAppOriginSchema,
  kind: z.literal(MCP_APP_TOOL_RESULT_KIND),
  result: z.json(),
});
export type McpAppToolInvocationResult = z.infer<typeof McpAppToolInvocationResultSchema>;

/** Capability the visible-UI preload exposes; absent on web and hidden hosts. */
export interface McpAppBridge {
  execute(request: McpAppExecuteRequest): Promise<McpAppExecuteResult>;
  prepare(request: McpAppPrepareRequest): Promise<McpAppPrepareResult>;
  /** Reads the app document through the content port; rejects on any failure. */
  readResource(origin: McpAppOrigin): Promise<string>;
  release(request: McpAppReleaseRequest): Promise<void>;
}

export function parseMcpAppPrepareRequest(value: unknown): McpAppPrepareRequest {
  return McpAppPrepareRequestSchema.parse(value);
}

export function parseMcpAppPrepareResult(value: unknown): McpAppPrepareResult {
  return McpAppPrepareResultSchema.parse(value);
}

export function parseMcpAppExecuteRequest(value: unknown): McpAppExecuteRequest {
  return McpAppExecuteRequestSchema.parse(value);
}

export function parseMcpAppExecuteResult(value: unknown): McpAppExecuteResult {
  return McpAppExecuteResultSchema.parse(value);
}

/** Exact-shape reader: anything that is not a complete marker is an ordinary result. */
export function readMcpAppToolInvocationResult(
  value: unknown
): McpAppToolInvocationResult | undefined {
  const parsed = McpAppToolInvocationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createMcpAppToolInvocationResult(
  app: McpAppOrigin,
  result: unknown
): McpAppToolInvocationResult {
  return McpAppToolInvocationResultSchema.parse({ app, kind: MCP_APP_TOOL_RESULT_KIND, result });
}
