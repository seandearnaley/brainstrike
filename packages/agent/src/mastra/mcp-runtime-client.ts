import {
  type McpHostPort,
  parseConfiguredMcpServerId,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ToolsInput } from '@mastra/core/agent';
import { type StandardSchemaWithJSON, toStandardSchema } from '@mastra/core/schema';
import { createTool, type MCPToolProperties, type ToolExecutionContext } from '@mastra/core/tools';
import { type McpConfigInput, parseMcpConfigValue } from '../mcp/config';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpListToolsResult,
  ExplicitHttpMcpRequestOptions,
  ExplicitHttpMcpTool,
} from '../mcp/explicit-http-client';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import { normalizeProgressPayload } from '../tools/progress-adapter';
import { readToolCallId } from '../tools/read-tool-call-id';
import { resolveGuardedToolSignal } from '../tools/tool-guard-deadline';
import type { StreamChunk } from '../types';
import {
  createMcpAppToolResult,
  hasMcpAppToolMeta,
  projectMcpAppOrTaskToolModelOutput,
  readMcpAppToolResourceUri,
} from './mcp-app-tool-result';
import { readMcpMultimodalOutput } from './mcp-multimodal-output';
import {
  createMcpTaskToolTracking,
  type McpTaskToolTracking,
  readMcpCreatedTaskResult,
  settleMcpTaskToolResult,
} from './mcp-task-tool-result';

const logger = createLogger('MastraAgentMcpRuntimeClient');
const rawCallToolResultSignals = new WeakSet<AbortSignal>();

export const MCP_PROGRESS_STREAM_PART_TYPE = 'brainstrike.mcp-progress.chunk';

/**
 * Mark one authority-owned execution signal as requiring the complete
 * successful MCP CallToolResult. The in-memory identity marker cannot be
 * forged by model input and survives Mastra's execution-context reconstruction
 * without adding a parallel transport callback.
 */
export function retainRawMcpCallToolResult(signal: AbortSignal): AbortSignal {
  rawCallToolResultSignals.add(signal);
  return signal;
}

export function shouldRetainRawMcpCallToolResult(signal: unknown): boolean {
  return Boolean(
    signal && typeof signal === 'object' && rawCallToolResultSignals.has(signal as AbortSignal)
  );
}

export interface McpToolsetsWithErrors {
  errors: Record<string, string>;
  toolsets: Record<string, ToolsInput>;
}

/** The only MCP lifecycle surface the agent runtime's discovery pipeline needs. */
export interface McpRuntimeClient {
  readonly configuredServers: readonly { enabledTools?: string[]; name: string }[];
  disconnect: () => Promise<void>;
  listToolsetsWithErrors: () => Promise<McpToolsetsWithErrors>;
}

interface OfficialSdkMcpClientLike {
  callTool: (
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpRequestOptions
  ) => Promise<ExplicitHttpMcpCallToolResult>;
  close: () => Promise<void>;
  listTools: (options?: ExplicitHttpMcpRequestOptions) => Promise<ExplicitHttpMcpListToolsResult>;
}

export interface CreateMcpRuntimeClientOptions {
  config: McpConfigInput | undefined;
  host?: McpHostPort;
  /**
   * Host-owned MCP Tasks tracking (BST-1566). Absent keeps every tool call
   * synchronous and makes a task-creating result a hard error — never a
   * silently unpersisted task.
   */
  mcpTaskTracking?: McpTaskTrackingCapability;
  /**
   * The tool guard ceiling the settlement wait is capped under. Required
   * whenever `mcpTaskTracking` is present so the wait can never outlive the
   * guard that would otherwise time the whole call out.
   */
  toolTimeoutMs?: number;
}

interface TransportOwnedServerClient {
  client: OfficialSdkMcpClientLike;
  server: { enabledTools?: string[]; name: string };
  taskTracking: McpTaskToolTracking | undefined;
}

function createHostClient(
  host: McpHostPort,
  serverName: string,
  generation: number
): OfficialSdkMcpClientLike {
  const configuredServerId = parseConfiguredMcpServerId(serverName);
  const lease = new AbortController();
  const retireIfChanged = () => {
    const current = host
      .snapshot()
      .servers.find((server) => server.configuredServerId === configuredServerId);
    if (current?.generation !== generation) {
      lease.abort(new Error('MCP host authority generation retired'));
    }
  };
  const unwatch = host.watch({ configuredServerIds: [configuredServerId] }, retireIfChanged);
  retireIfChanged();
  if (lease.signal.aborted) {
    unwatch();
    throw lease.signal.reason;
  }
  let closed = false;
  const requestOptions = (options?: ExplicitHttpMcpRequestOptions) => ({
    ...(options?.onprogress ? { onProgress: options.onprogress } : {}),
    signal: options?.signal ? AbortSignal.any([lease.signal, options.signal]) : lease.signal,
  });
  return {
    async callTool(params, options) {
      const operation = parseMcpHostOperation({
        configuredServerId,
        ...(params._meta ? { _meta: params._meta } : {}),
        ...(params.arguments ? { arguments: params.arguments } : {}),
        ...(params.task ? { task: params.task } : {}),
        toolName: params.name,
        type: 'tools/call',
      });
      const response = await host.invoke(operation, requestOptions(options));
      if (response.type !== 'tools/call') {
        throw new Error('MCP host returned the wrong operation result');
      }
      // McpHostPort's owning host validates the SDK result envelope before it
      // crosses this boundary. BrowserSafe preserves that JSON shape but erases
      // the SDK declaration identity, so restore the already-validated view.
      return response.result as ExplicitHttpMcpCallToolResult;
    },
    async close() {
      if (!closed) {
        closed = true;
        try {
          unwatch();
        } finally {
          lease.abort(new Error('MCP runtime adapter released'));
        }
      }
    },
    async listTools(options) {
      const response = await host.invoke(
        { configuredServerId, type: 'tools/list' },
        requestOptions(options)
      );
      if (response.type !== 'tools/list') {
        throw new Error('MCP host returned the wrong operation result');
      }
      // See callTool: the host is the validation authority for this SDK shape.
      return response.result as ExplicitHttpMcpListToolsResult;
    },
  };
}

/**
 * Build one runtime-scoped adapter over the host's singleton MCP authority.
 * The adapter owns only its watch/lease; it never constructs or closes an SDK client.
 */
export async function createMcpRuntimeClient(
  options: CreateMcpRuntimeClientOptions
): Promise<McpRuntimeClient | undefined> {
  if (options.host && options.config?.servers.length) {
    parseMcpConfigValue(options.config);
    throw new Error('Legacy runtime MCP config cannot compete with MCP host authority');
  }
  if (
    !options.host &&
    Array.isArray(options.config?.servers) &&
    options.config.servers.length === 0
  ) {
    return;
  }
  const config =
    options.config && !options.host ? parseMcpConfigValue(options.config).config : undefined;
  if (!options.host) {
    if (config && config.servers.length > 0) {
      throw new Error('Legacy runtime MCP config requires an MCP host capability');
    }
    return;
  }
  const authority = options.host.snapshot();
  const servers = authority.servers.map(({ configuredServerId, enabledTools, generation }) => ({
    ...(enabledTools ? { enabledTools: [...enabledTools] } : {}),
    generation,
    name: configuredServerId,
  }));
  if (servers.length === 0) {
    return;
  }
  const taskTracking = resolveTaskTracking(options);
  const serverClients: TransportOwnedServerClient[] = [];
  try {
    for (const { generation, ...server } of servers) {
      serverClients.push({
        client: createHostClient(options.host, server.name, generation),
        server,
        taskTracking,
      });
    }
    return new CompositeMcpRuntimeClient(serverClients);
  } catch (error) {
    await Promise.allSettled(serverClients.map(({ client }) => client.close()));
    throw error;
  }
}

function resolveTaskTracking(
  options: CreateMcpRuntimeClientOptions
): McpTaskToolTracking | undefined {
  if (!options.mcpTaskTracking) {
    return;
  }
  if (options.toolTimeoutMs === undefined) {
    throw new Error('MCP task tracking requires the tool guard timeout to bound settlement');
  }
  return createMcpTaskToolTracking(options.mcpTaskTracking, options.toolTimeoutMs);
}

class CompositeMcpRuntimeClient implements McpRuntimeClient {
  readonly configuredServers: readonly { enabledTools?: string[]; name: string }[];
  private closing: Promise<void> | undefined;
  constructor(private readonly serverClients: readonly TransportOwnedServerClient[]) {
    this.configuredServers = serverClients.map(({ server }) => structuredClone(server));
  }

  async listToolsetsWithErrors(): Promise<McpToolsetsWithErrors> {
    const toolsets: Record<string, ToolsInput> = {};
    const errors: Record<string, string> = {};
    await Promise.all(
      this.serverClients.map((entry) => this.discoverServer(entry, toolsets, errors))
    );
    return { errors, toolsets };
  }

  disconnect(): Promise<void> {
    this.closing ??= this.closeAdapters();
    return this.closing;
  }

  private async closeAdapters(): Promise<void> {
    const results = await Promise.allSettled(
      this.serverClients.map(({ client }) => client.close())
    );
    const failures: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        logger.warn('MCP adapter release failed', {
          error: result.reason,
          serverName: this.serverClients[index]?.server.name ?? 'unknown',
        });
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'MCP adapter release failed');
    }
  }

  private async discoverServer(
    entry: TransportOwnedServerClient,
    toolsets: Record<string, ToolsInput>,
    errors: Record<string, string>
  ): Promise<void> {
    try {
      const { tools } = await entry.client.listTools();
      defineOwn(toolsets, entry.server.name, convertMcpTools(entry, tools));
    } catch (error) {
      defineOwn(errors, entry.server.name, errorMessage(error));
    }
  }
}

function convertMcpTools(
  entry: TransportOwnedServerClient,
  tools: ExplicitHttpMcpTool[]
): ToolsInput {
  const converted: ToolsInput = {};
  for (const tool of tools) {
    defineOwn(converted, tool.name, createMcpTool(entry, tool));
  }
  return converted;
}

function createMcpTool(
  { client, server, taskTracking }: TransportOwnedServerClient,
  tool: ExplicitHttpMcpTool
): ToolsInput[string] {
  const toolMeta = stampServerIdInMeta(tool._meta, server.name);
  const annotations = normalizeToolAnnotations(tool.annotations);
  const mcp: MCPToolProperties | undefined =
    toolMeta || annotations
      ? {
          ...(toolMeta ? { _meta: toolMeta } : {}),
          ...(annotations ? { annotations } : {}),
        }
      : undefined;
  const strict = readStrictMeta(toolMeta);
  const hasAppMeta = hasMcpAppToolMeta(tool._meta);

  return createTool({
    description: tool.description ?? '',
    id: `${server.name}_${tool.name}`,
    // Mastra's JSON-schema standard adapter delegates validation to its JSON
    // Schema engine. Keeping the schema raw preserves 2020-12 composition
    // (`$defs`/`$ref`/`oneOf`/conditionals) instead of narrowing it through
    // zod's intentionally smaller fromJSONSchema converter.
    inputSchema: toStandardSchema(tool.inputSchema as Parameters<typeof toStandardSchema>[0]),
    ...(tool.outputSchema
      ? { outputSchema: createDocumentationOnlyMcpOutputSchema(tool.outputSchema) }
      : {}),
    ...(mcp ? { mcp } : {}),
    // Preserve the server's optional-input semantics. OpenAI Responses may
    // normalize an omitted strict flag by requiring every property, forcing
    // the model to invent filters such as Linear priority=0. Runtime JSON
    // Schema validation still runs; a server's explicit strict opt-in wins.
    strict: strict ?? false,
    // Tasks and Apps share one projector: Tasks get their bounded status view,
    // while Apps project the inner ordinary result. Definitions carrying
    // neither contract keep the generic pipeline path without a custom seam.
    ...(taskTracking || hasAppMeta ? { toModelOutput: projectMcpAppOrTaskToolModelOutput } : {}),
    execute: async (input, context) =>
      executeMcpTool(
        { client, server, taskTracking },
        tool.name,
        requireToolArguments(input),
        tool._meta,
        context
      ),
    // `appCapable` is the same marker predicate as the Apps projector above:
    // the Apps admission gate registers a run only when at least one is present.
    mcpMetadata: { serverName: server.name, ...(hasAppMeta ? { appCapable: true } : {}) },
  });
}

/**
 * The official MCP SDK has already validated structuredContent against the
 * advertised output schema. Mastra still needs that JSON schema for
 * discovery/documentation, but must not re-validate the complete CallToolResult
 * envelope against the inner schema.
 */
function createDocumentationOnlyMcpOutputSchema(
  outputSchema: NonNullable<ExplicitHttpMcpTool['outputSchema']>
): StandardSchemaWithJSON<unknown> {
  const standardSchema = toStandardSchema(outputSchema)['~standard'];
  return {
    '~standard': {
      ...standardSchema,
      validate: (value: unknown) => ({ value }),
    },
  };
}

/**
 * The slice of Mastra's ToolExecutionContext this client actually reads.
 * @mastra/core 1.55 made `observe` a required member of the full interface,
 * while the value createTool's execute callback receives is statically typed
 * as only `{ requestContext }` — so the full interface can no longer describe
 * the inbound context. `requestContext` stays in the slice so the callback's
 * context type shares a property with this weak type.
 *
 * VERSION-COUPLED: every member here is optional, so nothing type-checks that
 * Mastra still passes `agent`/`writer`/`abortSignal` at these positions — if
 * an upgrade relocates one (e.g. `writer` under `agent`), progress streaming
 * or cancellation degrades silently. Re-verify these three field paths against
 * the installed `tools/types.d.ts` on every @mastra/core bump (they were
 * verified at 1.55.0), alongside the doc's per-version surface checks.
 */
type McpExecuteContext = Pick<ToolExecutionContext, 'agent' | 'writer' | 'abortSignal'> & {
  requestContext?: unknown;
};

async function executeMcpTool(
  { client, server, taskTracking }: TransportOwnedServerClient,
  toolName: string,
  input: Record<string, unknown>,
  definitionMeta: Record<string, unknown> | undefined,
  context: McpExecuteContext
): Promise<unknown> {
  const serverName = server.name;
  const appResourceUri = readMcpAppToolResourceUri(definitionMeta);
  const appOrigin = appResourceUri
    ? { resourceUri: appResourceUri, serverId: serverName, toolName }
    : undefined;
  let progressWrites = Promise.resolve();
  let progressDeliveryError: unknown;
  let lastProgress = Number.NEGATIVE_INFINITY;
  const toolCallId = readToolCallId([undefined, context]);
  const writer = context?.writer;
  const onprogress: NonNullable<ExplicitHttpMcpRequestOptions['onprogress']> | undefined =
    toolCallId && writer
      ? (progress): void => {
          if (
            typeof progress.progress !== 'number' ||
            !Number.isFinite(progress.progress) ||
            progress.progress < lastProgress
          ) {
            return;
          }
          lastProgress = progress.progress;
          progressWrites = progressWrites
            .then(() =>
              writer.custom({
                progress: progress.progress,
                toolCallId,
                toolName: `${serverName}.${toolName}`,
                type: MCP_PROGRESS_STREAM_PART_TYPE,
                ...(progress.message === undefined ? {} : { message: progress.message }),
                ...(progress.total === undefined ? {} : { total: progress.total }),
              })
            )
            .catch((error: unknown) => {
              progressDeliveryError ??= error;
            });
        }
      : undefined;

  const finishProgressDelivery = async (): Promise<void> => {
    await progressWrites;
    if (progressDeliveryError === undefined) {
      return;
    }
    logger.warn('MCP progress delivery failed', {
      error: progressDeliveryError,
      serverName,
      toolName,
    });
  };

  let result: ExplicitHttpMcpCallToolResult;
  const requestMeta = readToolCallMeta(context);
  // The tool guard's deadline is folded in HERE rather than replacing
  // `context.abortSignal`: the execution signal's identity carries meaning
  // (`retainRawMcpCallToolResult`), and the host request is the thing that has
  // to stop when the guard gives up. Without it the SDK's
  // `resetTimeoutOnProgress` lets a progress-emitting server hold the request
  // for the full `maxTotalTimeout` after the run walked away (BST-1594).
  const callSignal = resolveGuardedToolSignal(context);
  try {
    result = await client.callTool(
      {
        arguments: input,
        name: toolName,
        ...(requestMeta ? { _meta: requestMeta } : {}),
      },
      {
        ...(callSignal ? { signal: callSignal } : {}),
        ...(onprogress ? { onprogress } : {}),
      }
    );
  } catch (error) {
    await finishProgressDelivery();
    throw error;
  }
  await finishProgressDelivery();

  // A created task is never a CallToolResult: it has no content to retain, no
  // isError, and no structuredContent. It is handed to the host's task
  // authorities and the tool settles on the bounded presentation instead.
  const createdTask = readMcpCreatedTaskResult(result);
  let ordinaryResult: unknown;
  if (createdTask && shouldRetainRawMcpCallToolResult(context.abortSignal)) {
    // App-originated call: the MCP App client expects the canonical
    // CreateTaskResult (its frame bridge bounds inbound requests at 10 s, far
    // under the settlement wait). The host still takes ownership of the task
    // through `track`; nothing awaits settlement here.
    if (!taskTracking) {
      throw new Error(
        `MCP tool "${serverName}.${toolName}" returned a task but this host has no task tracking capability`
      );
    }
    await taskTracking.capability.track(
      { configuredServerId: serverName, result: createdTask, toolName },
      context.abortSignal
    );
    return createdTask;
  }
  if (createdTask) {
    ordinaryResult = await settleMcpTaskToolResult({
      // `server.name` IS the configured server id: the host authority snapshot
      // exposes `configuredServerId` and createMcpRuntimeClient maps it to
      // `name` verbatim, so this matches McpTaskHandle.serverId on the host.
      configuredServerId: serverName,
      result: createdTask,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      toolName,
      tracking: taskTracking,
    });
  } else if (shouldRetainRawMcpCallToolResult(context.abortSignal)) {
    return result;
  } else if (result.isError) {
    throw new Error(extractMcpToolError(result));
  } else if (result.structuredContent === undefined || readMcpMultimodalOutput(result)) {
    ordinaryResult = result;
  } else {
    ordinaryResult = result.structuredContent;
  }
  return createMcpAppToolResult(appOrigin, ordinaryResult);
}

function readToolCallMeta(context: McpExecuteContext): Record<string, unknown> | undefined {
  const meta = (context as McpExecuteContext & { _meta?: unknown })._meta;
  if (!(meta && typeof meta === 'object' && !Array.isArray(meta))) {
    return;
  }
  return meta as Record<string, unknown>;
}

function extractMcpToolError(result: ExplicitHttpMcpCallToolResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 'MCP tool reported an error';
  }
  const text = content
    .flatMap((item: unknown) => {
      if (!(item && typeof item === 'object')) {
        return [];
      }
      const record = item as Record<string, unknown>;
      return record['type'] === 'text' && typeof record['text'] === 'string'
        ? [record['text']]
        : [];
    })
    .filter((value) => value.trim().length > 0)
    .join('\n');
  return text || 'MCP tool reported an error';
}

function requireToolArguments(input: unknown): Record<string, unknown> {
  if (!(input && typeof input === 'object' && !Array.isArray(input))) {
    throw new Error('MCP tool arguments must be an object');
  }
  return input as Record<string, unknown>;
}

function normalizeToolAnnotations(
  annotations: ExplicitHttpMcpTool['annotations']
): MCPToolProperties['annotations'] | undefined {
  if (!annotations) {
    return;
  }
  const normalized: NonNullable<MCPToolProperties['annotations']> = {};
  if (typeof annotations.title === 'string') {
    normalized.title = annotations.title;
  }
  if (typeof annotations.readOnlyHint === 'boolean') {
    normalized.readOnlyHint = annotations.readOnlyHint;
  }
  if (typeof annotations.destructiveHint === 'boolean') {
    normalized.destructiveHint = annotations.destructiveHint;
  }
  if (typeof annotations.idempotentHint === 'boolean') {
    normalized.idempotentHint = annotations.idempotentHint;
  }
  if (typeof annotations.openWorldHint === 'boolean') {
    normalized.openWorldHint = annotations.openWorldHint;
  }
  return normalized;
}

function stampServerIdInMeta(
  meta: Record<string, unknown> | undefined,
  serverName: string
): Record<string, unknown> | undefined {
  if (!meta) {
    return;
  }
  const ui = meta['ui'];
  if (!(ui && typeof ui === 'object' && 'resourceUri' in ui)) {
    return meta;
  }
  return {
    ...meta,
    ui: { ...(ui as Record<string, unknown>), serverId: serverName },
  };
}

function readStrictMeta(meta: Record<string, unknown> | undefined): boolean | undefined {
  const mastra = meta?.['mastra'];
  if (!(mastra && typeof mastra === 'object')) {
    return;
  }
  const strict = (mastra as Record<string, unknown>)['strict'];
  return typeof strict === 'boolean' ? strict : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function defineOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function mapMcpProgressStreamPart(part: unknown): StreamChunk | undefined {
  if (!(part && typeof part === 'object')) {
    return;
  }
  const record = part as Record<string, unknown>;
  if (record['type'] !== MCP_PROGRESS_STREAM_PART_TYPE) {
    return;
  }
  const toolCallId = record['toolCallId'];
  const toolName = record['toolName'];
  const progress = record['progress'];
  const total = record['total'];
  const message = record['message'];
  if (
    typeof toolCallId !== 'string' ||
    toolCallId.length === 0 ||
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    typeof progress !== 'number' ||
    !Number.isFinite(progress) ||
    (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total))) ||
    (message !== undefined && typeof message !== 'string')
  ) {
    return;
  }

  const raw = {
    done: progress,
    ...(message === undefined ? {} : { message }),
    ...(total === undefined ? {} : { total }),
  };
  const normalized = normalizeProgressPayload(raw);
  return {
    name: toolName,
    payload: {
      callId: toolCallId,
      toolCallId,
      ...normalized,
    },
    status: 'progress',
    type: 'tool-event',
  };
}
