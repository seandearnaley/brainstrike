import { z } from 'zod';

/**
 * Renderer ↔ desktop-main contract for production MCP Apps (BST-1572
 * enablement). The renderer owns the sandbox policy, provenance, frame
 * bridge, and the tool-call authority's approval state; the main process owns
 * admission (prepare / execute / release against the live assistant run),
 * resource reads, and the shell registry that serves each mount's sandbox
 * shell from the privileged `brainstrike-mcp-app:` scheme (prepareShell /
 * releaseShell). Channel names are the single source of truth for preload
 * and IPC.
 */
export const MCP_APPS_IPC_CHANNELS = Object.freeze({
  execute: 'mcp:apps:execute',
  prepare: 'mcp:apps:prepare',
  prepareShell: 'mcp:apps:prepareShell',
  release: 'mcp:apps:release',
  releaseShell: 'mcp:apps:releaseShell',
} as const);

/** Scheme the desktop main process serves registered sandbox shells from. */
export const MCP_APP_SHELL_URL_SCHEME = 'brainstrike-mcp-app';
export const MCP_APP_SHELL_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
/** Upper bound for one shell document (the renderer owner enforces a tighter budget). */
export const MCP_APP_SHELL_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

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
  /**
   * The persisted thread whose tool result mounted the app. Admission resolves
   * the live run of exactly this thread, never another thread's run that
   * happens to know the same server.
   */
  threadId: IdentifierSchema,
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

/**
 * A rendered sandbox shell the renderer asks main to serve. The policies are
 * delivered as RESPONSE HEADERS by the shell protocol (a meta tag cannot
 * carry Permissions-Policy, and the nested srcdoc app frame inherits only a
 * header CSP), so they travel beside the document rather than inside it.
 */
export const McpAppShellPrepareRequestSchema = z.strictObject({
  contentSecurityPolicy: z.string().min(1).max(16_384),
  document: z.string().min(1).max(MCP_APP_SHELL_DOCUMENT_MAX_BYTES),
  permissionsPolicy: z.string().min(1).max(4096),
});
export type McpAppShellPrepareRequest = z.infer<typeof McpAppShellPrepareRequestSchema>;

const ShellTokenSchema = z.string().regex(MCP_APP_SHELL_TOKEN_PATTERN);

export const McpAppShellPrepareResultSchema = z
  .strictObject({
    shellUrl: z.string().min(1).max(256),
    token: ShellTokenSchema,
  })
  .refine((value) => value.shellUrl === `${MCP_APP_SHELL_URL_SCHEME}://${value.token}/`, {
    message: 'MCP App shell URL must be the token root on the shell scheme',
  });
export type McpAppShellPrepareResult = z.infer<typeof McpAppShellPrepareResultSchema>;

export const McpAppShellReleaseRequestSchema = z.strictObject({ token: ShellTokenSchema });
export type McpAppShellReleaseRequest = z.infer<typeof McpAppShellReleaseRequestSchema>;

/** Capability the visible-UI preload exposes; absent on web and hidden hosts. */
export interface McpAppBridge {
  execute(request: McpAppExecuteRequest): Promise<McpAppExecuteResult>;
  prepare(request: McpAppPrepareRequest): Promise<McpAppPrepareResult>;
  /** Registers a rendered shell; main serves it at the returned `brainstrike-mcp-app:` URL. */
  prepareShell(request: McpAppShellPrepareRequest): Promise<McpAppShellPrepareResult>;
  /** Reads the app document through the content port; rejects on any failure. */
  readResource(origin: McpAppOrigin): Promise<string>;
  release(request: McpAppReleaseRequest): Promise<void>;
  /** Unregisters a shell; its URL answers 404 from this point on. */
  releaseShell(request: McpAppShellReleaseRequest): Promise<void>;
}

/** Cheap discriminator probe shared by the persisted tool-result marker readers. */
export function hasToolResultKind(value: unknown, kind: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'kind' in value &&
    value.kind === kind
  );
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

export function parseMcpAppShellPrepareRequest(value: unknown): McpAppShellPrepareRequest {
  return McpAppShellPrepareRequestSchema.parse(value);
}

export function parseMcpAppShellPrepareResult(value: unknown): McpAppShellPrepareResult {
  return McpAppShellPrepareResultSchema.parse(value);
}

export function parseMcpAppShellReleaseRequest(value: unknown): McpAppShellReleaseRequest {
  return McpAppShellReleaseRequestSchema.parse(value);
}

/**
 * Exact-shape reader: anything that is not a complete marker is an ordinary
 * result. This sits on per-render and per-projection hot paths, so a result
 * without the marker `kind` short-circuits before the schema walks the
 * (arbitrarily large) payload; a value carrying the kind is validated fully.
 */
export function readMcpAppToolInvocationResult(
  value: unknown
): McpAppToolInvocationResult | undefined {
  if (!hasToolResultKind(value, MCP_APP_TOOL_RESULT_KIND)) {
    return undefined;
  }
  const parsed = McpAppToolInvocationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createMcpAppToolInvocationResult(
  app: McpAppOrigin,
  result: unknown
): McpAppToolInvocationResult {
  return McpAppToolInvocationResultSchema.parse({ app, kind: MCP_APP_TOOL_RESULT_KIND, result });
}
