import { Schema } from 'effect';
/**
 * Production MCP Apps contract (BST-1572 enablement). The renderer owns the
 * sandbox policy, provenance, frame bridge, and the tool-call authority's
 * approval state; the agent host admits and runs each app tool call (prepare /
 * execute / release) under the owning thread's policy; the desktop main
 * process owns resource reads and the shell registry that serves each mount's
 * sandbox shell from the privileged `brainstrike-mcp-app:` scheme
 * (prepareShell / releaseShell). This module owns the payload schemas; the
 * desktop pure IPC contract owns channel names and authorization.
 */
/** Scheme the desktop main process serves registered sandbox shells from. */
export const MCP_APP_SHELL_URL_SCHEME = 'brainstrike-mcp-app';
export const MCP_APP_SHELL_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
/** Upper bound for one shell document (the renderer owner enforces a tighter budget). */
export const MCP_APP_SHELL_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APPS_PREPARATION_ID_MAX_LENGTH = 256;
const IdentifierSchema = Schema.String.check(Schema.isMinCodePoints(1)).check(
  Schema.isMaxCodePoints(512)
);
const PreparationIdSchema = Schema.String.check(Schema.isMinCodePoints(1)).check(
  Schema.isMaxCodePoints(MCP_APPS_PREPARATION_ID_MAX_LENGTH)
);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
/** Where an app came from: the same-server tool and resource that own it. */
export const McpAppOriginSchema = Schema.Struct({
  mimeType: Schema.Literal(MCP_APPS_MIME_TYPE),
  resourceUri: Schema.String.check(Schema.isMinCodePoints(1))
    .check(Schema.isMaxCodePoints(2048))
    .check(Schema.isStartingWith('ui://')),
  serverId: IdentifierSchema,
  toolName: IdentifierSchema,
});
export type McpAppOrigin = (typeof McpAppOriginSchema)['Type'];
export const McpAppPrepareRequestSchema = Schema.Struct({
  arguments: JsonObjectSchema,
  origin: McpAppOriginSchema,
  preparationId: PreparationIdSchema,
  threadId: IdentifierSchema,
  toolName: IdentifierSchema,
});
export type McpAppPrepareRequest = (typeof McpAppPrepareRequestSchema)['Type'];
export const McpAppPrepareResultSchema = Schema.Struct({
  decision: Schema.Literals(['allow', 'ask']),
  riskCategory: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(128)),
});
export type McpAppPrepareResult = (typeof McpAppPrepareResultSchema)['Type'];
export const McpAppExecuteRequestSchema = Schema.Struct({ preparationId: PreparationIdSchema });
export type McpAppExecuteRequest = (typeof McpAppExecuteRequestSchema)['Type'];
export const McpAppExecuteResultSchema = Schema.Struct({ result: Schema.MutableJson });
export type McpAppExecuteResult = (typeof McpAppExecuteResultSchema)['Type'];
export const McpAppReleaseRequestSchema = McpAppExecuteRequestSchema;
export type McpAppReleaseRequest = (typeof McpAppReleaseRequestSchema)['Type'];
/**
 * The raw domain result a tool call persists when the tool definition carried
 * `_meta.ui.resourceUri`. The thread correlates an app mount to the tool call
 * through this marker; `result` is the ordinary tool result the model saw.
 */
export const MCP_APP_TOOL_RESULT_KIND = 'mcp-app';
export const McpAppToolInvocationResultSchema = Schema.Struct({
  app: McpAppOriginSchema,
  kind: Schema.Literal(MCP_APP_TOOL_RESULT_KIND),
  result: Schema.MutableJson,
});
export type McpAppToolInvocationResult = (typeof McpAppToolInvocationResultSchema)['Type'];
/**
 * A rendered sandbox shell the renderer asks main to serve. The policies are
 * delivered as RESPONSE HEADERS by the shell protocol (a meta tag cannot
 * carry Permissions-Policy, and the nested srcdoc app frame inherits only a
 * header CSP), so they travel beside the document rather than inside it.
 */
export const McpAppShellPrepareRequestSchema = Schema.Struct({
  contentSecurityPolicy: Schema.String.check(Schema.isMinCodePoints(1)).check(
    Schema.isMaxCodePoints(16_384)
  ),
  document: Schema.String.check(Schema.isMinCodePoints(1)).check(
    Schema.isMaxCodePoints(MCP_APP_SHELL_DOCUMENT_MAX_BYTES)
  ),
  permissionsPolicy: Schema.String.check(Schema.isMinCodePoints(1)).check(
    Schema.isMaxCodePoints(4096)
  ),
});
export type McpAppShellPrepareRequest = (typeof McpAppShellPrepareRequestSchema)['Type'];
const ShellTokenSchema = Schema.String.check(Schema.isPattern(MCP_APP_SHELL_TOKEN_PATTERN));
export const McpAppShellPrepareResultSchema = Schema.Struct({
  shellUrl: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(256)),
  token: ShellTokenSchema,
}).check(
  Schema.makeFilter((value) =>
    value.shellUrl === `${MCP_APP_SHELL_URL_SCHEME}://${value.token}/`
      ? undefined
      : { issue: 'MCP App shell URL must be the token root on the shell scheme', path: [] }
  )
);
export type McpAppShellPrepareResult = (typeof McpAppShellPrepareResultSchema)['Type'];
export const McpAppShellReleaseRequestSchema = Schema.Struct({ token: ShellTokenSchema });
export type McpAppShellReleaseRequest = (typeof McpAppShellReleaseRequestSchema)['Type'];
/** What an app mount needs from its host: its shell and document, and its tool calls' admission. */
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
/**
 * The part of the bridge the visible-UI preload exposes, the app's shell;
 * absent on web and hidden hosts. The app's document is read from the agent
 * host (BST-1930 c5d).
 */
export type McpAppShellBridge = Pick<McpAppBridge, 'prepareShell' | 'releaseShell'>;
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
  return Schema.decodeUnknownSync(McpAppPrepareRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppPrepareResult(value: unknown): McpAppPrepareResult {
  return Schema.decodeUnknownSync(McpAppPrepareResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppExecuteRequest(value: unknown): McpAppExecuteRequest {
  return Schema.decodeUnknownSync(McpAppExecuteRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppExecuteResult(value: unknown): McpAppExecuteResult {
  return Schema.decodeUnknownSync(McpAppExecuteResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppShellPrepareRequest(value: unknown): McpAppShellPrepareRequest {
  return Schema.decodeUnknownSync(McpAppShellPrepareRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppShellPrepareResult(value: unknown): McpAppShellPrepareResult {
  return Schema.decodeUnknownSync(McpAppShellPrepareResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpAppShellReleaseRequest(value: unknown): McpAppShellReleaseRequest {
  return Schema.decodeUnknownSync(McpAppShellReleaseRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
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
  const parsed = Schema.decodeUnknownResult(McpAppToolInvocationResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  return parsed._tag === 'Success' ? parsed.success : undefined;
}
export function createMcpAppToolInvocationResult(
  app: McpAppOrigin,
  result: unknown
): McpAppToolInvocationResult {
  return Schema.decodeUnknownSync(McpAppToolInvocationResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({ app, kind: MCP_APP_TOOL_RESULT_KIND, result });
}
