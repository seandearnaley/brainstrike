import { ResponseError } from 'vscode-jsonrpc';
import { z } from 'zod';

/**
 * Private Main and Node methods while Main still serves renderer MCP surfaces
 * (BST-1930 c1 interim). Two groups, each with a removal point:
 *
 * - Node to Main `platform/*` adapters: Electron `shell.openExternal`, and the
 *   readiness handshake that opens `mcp-runtime/*` to Main. The host owns its
 *   MCP config, extension dials, tool preferences, credentials and Tasks.
 * - Main to Node `mcp-runtime/*`: Main's remaining renderer surfaces (Apps,
 *   their task tracking, content), the native config picker and factory reset
 *   reach the host's runtime and settings authority. Status, lifecycle
 *   control, Tasks cards and global elicitation are public host methods
 *   (c5b-c5c); the rest go with c5d-e.
 */
export const MCP_STORE_METHODS = {
  openExternal: 'platform/open-external',
  ready: 'platform/mcp/ready',
} as const;

export const MCP_RUNTIME_METHODS = {
  /** Main's native picker chose an MCP config file; the host selects it. */
  configPathPick: 'mcp-runtime/config/path/pick',
  control: 'mcp-runtime/control',
  invoke: 'mcp-runtime/invoke',
  /** Factory reset: retire the settings lifecycle and keep a restore point. */
  settingsReset: 'mcp-runtime/settings/reset',
  /** After a factory reset: reopen the settings lifecycle, restoring it if the reset failed. */
  settingsResume: 'mcp-runtime/settings/resume',
  snapshot: 'mcp-runtime/snapshot',
  tasksTrack: 'mcp-runtime/tasks/track',
} as const;

export const MCP_RUNTIME_NOTIFICATIONS = {
  progress: 'mcp-runtime/progress',
  /** The host's tool registry changed; Main mirrors it for its remaining readers. */
  tools: 'mcp-runtime/tools',
  watch: 'mcp-runtime/watch',
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

/** The registry calls a mirror makes; each `@brainstrike/agent` bundle has its own instance. */
export interface McpToolRegistryMirrorTarget {
  clear(): void;
  disableTools(toolIds: string[]): void;
  register(serverName: string, tools: Readonly<Record<string, McpRegistryMirrorTool>>): void;
}

interface McpRegistryMirrorTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** Replace `registry` with exactly the host's published tool registry state. */
export function mirrorMcpToolRegistryState(
  registry: McpToolRegistryMirrorTarget,
  state: McpToolRegistryState
): void {
  registry.clear();
  const disabled: string[] = [];
  for (const [serverName, tools] of Object.entries(state)) {
    registry.register(
      serverName,
      Object.fromEntries(
        tools.map((tool) => [
          tool.id,
          {
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          },
        ])
      )
    );
    disabled.push(...tools.filter((tool) => !tool.enabled).map((tool) => tool.id));
  }
  if (disabled.length > 0) {
    registry.disableTools(disabled);
  }
}

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
