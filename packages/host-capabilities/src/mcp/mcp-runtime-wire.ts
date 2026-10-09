import { ResponseError } from 'vscode-jsonrpc';
import { z } from 'zod';

/**
 * Private Main↔Node methods while the desktop's one MCP runtime lives in the
 * Node host (BST-1930 stage c1). Two interim groups, each with a removal point:
 *
 * - Node → Main `platform/mcp/*` store adapters: the decrypted config, Electron
 *   `shell.openExternal` and the safeStorage MCP OAuth records. Each goes when
 *   its store moves to Node (OAuth records to the shared credential store,
 *   host-owned config). Bearer references already live in the profile
 *   credential store Node reads directly, and Tasks in the host's StateStore.
 *   `platform/mcp/tasks/legacy` reads Main's PGlite Tasks rows once, for the
 *   host's import; it goes when PGlite leaves the desktop.
 * - Main → Node `mcp-runtime/*`: Main's renderer surfaces (settings, status,
 *   tasks, elicitation, Apps, content) reach that runtime. They go in c5, when
 *   the renderer calls public host-protocol methods instead.
 */
export const MCP_STORE_METHODS = {
  oauthClear: 'platform/mcp/oauth/clear',
  oauthClearAll: 'platform/mcp/oauth/clear-all',
  oauthRead: 'platform/mcp/oauth/read',
  oauthWrite: 'platform/mcp/oauth/write',
  openExternal: 'platform/open-external',
  ready: 'platform/mcp/ready',
  state: 'platform/mcp/state',
  tasksLegacy: 'platform/mcp/tasks/legacy',
} as const;

export const MCP_RUNTIME_METHODS = {
  config: 'mcp-runtime/config',
  control: 'mcp-runtime/control',
  elicitationAttach: 'mcp-runtime/elicitation/attach',
  elicitationDetach: 'mcp-runtime/elicitation/detach',
  elicitationSettle: 'mcp-runtime/elicitation/settle',
  extensions: 'mcp-runtime/extensions',
  invoke: 'mcp-runtime/invoke',
  snapshot: 'mcp-runtime/snapshot',
  tasksAct: 'mcp-runtime/tasks/act',
  tasksList: 'mcp-runtime/tasks/list',
  tasksTrack: 'mcp-runtime/tasks/track',
  tools: 'mcp-runtime/tools',
} as const;

export const MCP_RUNTIME_NOTIFICATIONS = {
  elicitationFinalized: 'mcp-runtime/elicitation/finalized',
  elicitationRequested: 'mcp-runtime/elicitation/requested',
  progress: 'mcp-runtime/progress',
  tasksChanged: 'mcp-runtime/tasks/changed',
  watch: 'mcp-runtime/watch',
} as const;

export const McpOAuthIdentitySchema = z.strictObject({
  resourceUrl: z.string().min(1),
  scopeKey: z.string(),
  serverId: z.string().min(1),
});

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

/**
 * Main's desired MCP state at one revision: the decrypted config, the global
 * extension dials and the Settings tool registry. Node reports the revision it
 * applied in `platform/mcp/ready`; Main pushes anything newer.
 */
export const McpDesiredStateSchema = z.strictObject({
  config: z.json(),
  extensionPreferences: z.json(),
  revision: z.number().int().nonnegative(),
  tools: McpToolRegistryStateSchema,
});
export type McpDesiredState = z.infer<typeof McpDesiredStateSchema>;

const ERROR_DATA = z.object({
  category: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
});

/** A remote failure keeps its typed identity (`code`, `category`, `name`) and message. */
export class RemoteMcpRuntimeError extends Error {
  readonly category: string | undefined;
  readonly code: string | number | undefined;
  constructor(message: string, data: z.infer<typeof ERROR_DATA>) {
    super(message);
    this.name = data.name ?? 'RemoteMcpRuntimeError';
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
  return new RemoteMcpRuntimeError(cause.message, data.success ? data.data : {});
}

/** Run a handler body and encode its failure for the private response. */
export async function respond(work: () => unknown): Promise<unknown> {
  try {
    return await work();
  } catch (cause) {
    throw encodeMcpRuntimeError(cause);
  }
}
