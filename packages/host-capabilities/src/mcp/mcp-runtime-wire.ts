import { parseMcpHostCloseReport } from '@brainstrike/assistant-contract/mcp-host-runtime';
import { parseMcpHostSnapshot } from '@brainstrike/assistant-contract/mcp-host-status';
import { ResponseError } from 'vscode-jsonrpc';
import { z } from 'zod';

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
export const McpDiagnosticScopeSchema = z.enum([
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

const McpDiagnosticRecordSchema = z.strictObject({
  args: z.array(z.json()),
  bindings: z.record(z.string(), z.json()),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  message: z.string().optional(),
  scope: McpDiagnosticScopeSchema,
  timestamp: z.number().nonnegative(),
});
const McpSuccessfulCloseReportSchema = z
  .unknown()
  .transform(parseMcpHostCloseReport)
  .refine((report) => report.failures.length === 0, 'MCP cleanup did not complete successfully');
const McpResetSnapshotSchema = z
  .unknown()
  .transform(parseMcpHostSnapshot)
  .refine((snapshot) => snapshot.servers.length === 0, 'MCP reset left configured servers');

/** Redacted producer records and receipts from actual joined MCP cleanup. */
export const McpDiagnosticEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ record: McpDiagnosticRecordSchema, type: z.literal('record') }),
  z.strictObject({ hostCloseReport: McpSuccessfulCloseReportSchema, type: z.literal('shutdown') }),
  z.strictObject({
    hostCloseReport: McpSuccessfulCloseReportSchema,
    snapshot: McpResetSnapshotSchema,
    type: z.literal('reset'),
  }),
]);
export type McpDiagnosticEvent = z.infer<typeof McpDiagnosticEventSchema>;

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
export const McpToolRegistryStateSchema = z.record(
  z.string(),
  z.array(
    z.object({
      description: z.string().optional(),
      enabled: z.boolean(),
      id: z.string().min(1),
      inputSchema: z.json().optional(),
    })
  )
);
export type McpToolRegistryState = z.infer<typeof McpToolRegistryStateSchema>;

const ERROR_DATA = z.object({
  category: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
});

/** A remote failure keeps its typed identity (`code`, `category`, `name`) and message. */
export class McpHostWireError extends Error {
  readonly category: string | undefined;
  readonly code: string | number | undefined;
  constructor(message: string, data: z.infer<typeof ERROR_DATA>) {
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
  const data = ERROR_DATA.safeParse(cause.data);
  return new McpHostWireError(cause.message, data.success ? data.data : {});
}

/** Run a handler body and encode its failure for the private response. */
export async function respond(work: () => unknown): Promise<unknown> {
  try {
    return await work();
  } catch (cause) {
    throw encodeMcpRuntimeError(cause);
  }
}
