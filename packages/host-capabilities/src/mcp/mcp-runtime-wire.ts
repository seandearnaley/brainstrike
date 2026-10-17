import { parseMcpHostCloseReport } from '@brainstrike/assistant-contract/mcp-host-runtime';
import { parseMcpHostSnapshot } from '@brainstrike/assistant-contract/mcp-host-status';
import {
  opaqueWireSchema,
  wireResultDecoder,
} from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import { ResponseError } from 'vscode-jsonrpc';

/**
 * Private Main and Node methods (BST-1930 c5e). Two groups:
 *
 * - Node to Main `platform/*` adapters: Electron `shell.openExternal`, scoped
 *   MCP diagnostics, and the readiness handshake that opens `mcp-runtime/*` to Main.
 * - Main to Node `mcp-runtime/*`: the native picker's chosen config file, the
 *   factory reset's retire and reopen, and the tools persona availability
 *   reads. Everything else MCP is a public host method; Main owns no runtime.
 */
export const MCP_STORE_METHODS = {
  diagnostics: 'platform/mcp/diagnostics',
  openExternal: 'platform/open-external',
  ready: 'platform/mcp/ready',
} as const;

/** Only records from the desktop's owned MCP composition cross this adapter. */
export const McpDiagnosticScopeSchema = Schema.Literals([
  'DesktopMcpHostConnection',
  'DesktopNodeMcpHost',
  'McpConfigFile',
  'McpContentService',
  'McpDesktopTaskHost',
  'McpHostRuntime',
  'McpHostServices',
  'McpLifecycleErrors',
  'McpOAuthClientProvider',
  'McpPresentationService',
  'McpSettingsAuthority',
  'McpToolDiscovery',
]);

const McpDiagnosticRecordSchema = Schema.Struct({
  args: Schema.mutable(Schema.Array(Schema.MutableJson)),
  bindings: Schema.Record(Schema.String, Schema.MutableJson),
  level: Schema.Literals(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  message: Schema.optional(Schema.String),
  scope: McpDiagnosticScopeSchema,
  timestamp: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
const McpSuccessfulCloseReportSchema = opaqueWireSchema(parseMcpHostCloseReport).check(
  Schema.makeFilter((report) =>
    report.failures.length === 0
      ? undefined
      : { issue: 'MCP cleanup did not complete successfully', path: [] }
  )
);
const McpResetSnapshotSchema = opaqueWireSchema(parseMcpHostSnapshot).check(
  Schema.makeFilter((snapshot) =>
    snapshot.servers.length === 0
      ? undefined
      : { issue: 'MCP reset left configured servers', path: [] }
  )
);

/** Redacted producer records and receipts from actual joined MCP cleanup. */
export const McpDiagnosticEventSchema = Schema.Union(
  [
    Schema.Struct({ record: McpDiagnosticRecordSchema, type: Schema.Literal('record') }),
    Schema.Struct({
      hostCloseReport: McpSuccessfulCloseReportSchema,
      type: Schema.Literal('shutdown'),
    }),
    Schema.Struct({
      hostCloseReport: McpSuccessfulCloseReportSchema,
      snapshot: McpResetSnapshotSchema,
      type: Schema.Literal('reset'),
    }),
  ],
  { mode: 'oneOf' }
);
export type McpDiagnosticEvent = (typeof McpDiagnosticEventSchema)['Type'];

export const MCP_RUNTIME_METHODS = {
  /** Main's native picker chose an MCP config file; the host selects it. */
  configPathPick: 'mcp-runtime/config/path/pick',
  /** Factory reset: retire the settings lifecycle and keep a restore point. */
  settingsReset: 'mcp-runtime/settings/reset',
  /** After a factory reset: reopen the settings lifecycle, restoring it if the reset failed. */
  settingsResume: 'mcp-runtime/settings/resume',
  /** The host's MCP tools, read once for Main's persona availability. */
  toolsRead: 'mcp-runtime/tools/read',
} as const;

/** One tool registry entry, exactly as `mcpToolRegistry.getAllTools()` publishes it. */
export const McpToolRegistryStateSchema = Schema.Record(
  Schema.String,
  Schema.mutable(
    Schema.Array(
      Schema.Struct({
        description: Schema.optional(Schema.String),
        enabled: Schema.Boolean,
        id: Schema.String.check(Schema.isMinCodePoints(1)),
        inputSchema: Schema.optional(Schema.MutableJson),
      })
    )
  )
);
export type McpToolRegistryState = (typeof McpToolRegistryStateSchema)['Type'];

const ERROR_DATA = Schema.Struct({
  category: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  name: Schema.optional(Schema.String),
});

/** A remote failure keeps its typed identity (`code`, `category`, `name`) and message. */
export class McpHostWireError extends Error {
  readonly category: string | undefined;
  readonly code: string | number | undefined;
  constructor(message: string, data: (typeof ERROR_DATA)['Type']) {
    super(message);
    this.name = data.name ?? 'McpHostWireError';
    this.code = data.code;
    this.category = data.category;
  }
}

/** Encode a thrown value for the private response, keeping its typed identity. */
export function encodeMcpRuntimeError(cause: unknown): ResponseError<unknown> {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const record = error as Error & { category?: unknown; code?: unknown };
  return new ResponseError(-32_000, error.message, {
    ...(typeof record.category === 'string' ? { category: record.category } : {}),
    ...(typeof record.code === 'string' || typeof record.code === 'number'
      ? { code: record.code }
      : {}),
    name: error.name,
  });
}

/** Rehydrate an encoded failure; anything else stays the transport's own error. */
export function decodeMcpRuntimeError(cause: unknown): unknown {
  if (!(cause instanceof ResponseError) || cause.code !== -32_000) {
    return cause;
  }
  const data = wireResultDecoder(ERROR_DATA)(cause.data);
  return new McpHostWireError(cause.message, data._tag === 'Success' ? data.success : {});
}

/** Run a handler body and encode its failure for the private response. */
export async function respond(work: () => unknown): Promise<unknown> {
  try {
    return await work();
  } catch (cause) {
    throw encodeMcpRuntimeError(cause);
  }
}
