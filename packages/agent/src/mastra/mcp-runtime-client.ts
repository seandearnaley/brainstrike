import { createLogger } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import { type StandardSchemaWithJSON, toStandardSchema } from '@mastra/core/schema';
import { createTool, type MCPToolProperties, type ToolExecutionContext } from '@mastra/core/tools';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
import { type McpConfig, McpConfigSchema, type McpServer } from '../mcp/config';
import {
  type ExplicitHttpMcpCallToolParams,
  type ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
  type ExplicitHttpMcpListToolsResult,
  type ExplicitHttpMcpRequestOptions,
  type ExplicitHttpMcpTool,
} from '../mcp/explicit-http-client';
import { normalizeProgressPayload } from '../tools/progress-adapter';
import type { StreamChunk } from '../types';
import { readMcpMultimodalOutput } from './tool-model-output';

const logger = createLogger('MastraAgentMcpRuntimeClient');

export const MCP_PROGRESS_STREAM_PART_TYPE = 'brainstrike.mcp-progress.chunk';

export interface McpToolsetsWithErrors {
  errors: Record<string, string>;
  toolsets: Record<string, ToolsInput>;
}

/** The only MCP lifecycle surface the agent runtime's discovery pipeline needs. */
export interface McpRuntimeClient {
  disconnect: () => Promise<void>;
  listToolsetsWithErrors: () => Promise<McpToolsetsWithErrors>;
}

interface ExplicitHttpMcpClientLike {
  callTool: (
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpRequestOptions
  ) => Promise<ExplicitHttpMcpCallToolResult>;
  close: () => Promise<void>;
  listTools: (options?: ExplicitHttpMcpRequestOptions) => Promise<ExplicitHttpMcpListToolsResult>;
}

export interface McpRuntimeClientDependencies {
  createExplicitHttpClient: (options: ExplicitHttpMcpClientOptions) => ExplicitHttpMcpClientLike;
  createMastraClient: (options: MCPClientOptions) => McpRuntimeClient;
}

export interface CreateMcpRuntimeClientOptions {
  config: McpConfig | undefined;
  dependencies?: McpRuntimeClientDependencies;
  id: string;
}

type StdioServer = Extract<McpServer, { transport: 'stdio' }>;
type HttpServer = Extract<McpServer, { transport: 'sse' | 'streamable-http' }>;

interface ExplicitServerClient {
  client: ExplicitHttpMcpClientLike;
  server: HttpServer;
}

const defaultDependencies: McpRuntimeClientDependencies = {
  createExplicitHttpClient: (options) => new ExplicitHttpMcpClient(options),
  createMastraClient: (options) => new MCPClient(options),
};

/**
 * Build one structural runtime client while keeping transport ownership explicit:
 * Mastra owns stdio only; the official MCP SDK client owns each selected HTTP
 * transport without probing, path inference, or fallback.
 */
export function createMcpRuntimeClient(
  options: CreateMcpRuntimeClientOptions
): McpRuntimeClient | undefined {
  if (!options.config) {
    return;
  }
  if (Array.isArray(options.config.servers) && options.config.servers.length === 0) {
    return;
  }
  const { servers } = McpConfigSchema.parse(options.config);

  const dependencies = options.dependencies ?? defaultDependencies;
  const stdioServers = servers.filter(
    (server): server is StdioServer => server.transport === 'stdio'
  );
  const httpServers = servers.filter(
    (server): server is HttpServer =>
      server.transport === 'sse' || server.transport === 'streamable-http'
  );

  const mastraClient = createMastraStdioClient(stdioServers, options.id, dependencies);
  const explicitServers = httpServers.map((server): ExplicitServerClient => {
    const clientOptions: ExplicitHttpMcpClientOptions = {
      name: server.name,
      transport: server.transport,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
    return {
      client: dependencies.createExplicitHttpClient(clientOptions),
      server,
    };
  });

  if (!(mastraClient || explicitServers.length > 0)) {
    return;
  }
  return new CompositeMcpRuntimeClient(mastraClient, stdioServers, explicitServers);
}

function createMastraStdioClient(
  servers: StdioServer[],
  id: string,
  dependencies: McpRuntimeClientDependencies
): McpRuntimeClient | undefined {
  if (servers.length === 0) {
    return;
  }

  const serverMap: MCPClientOptions['servers'] = {};
  for (const server of servers) {
    const entry: MCPClientOptions['servers'][string] = { command: server.command };
    if (server.args && server.args.length > 0) {
      entry.args = server.args;
    }
    if (server.env && Object.keys(server.env).length > 0) {
      entry.env = server.env;
    }
    defineOwn(serverMap, server.name, entry);
  }
  return dependencies.createMastraClient({ id: `${id}-stdio`, servers: serverMap });
}

class CompositeMcpRuntimeClient implements McpRuntimeClient {
  constructor(
    private readonly mastraClient: McpRuntimeClient | undefined,
    private readonly stdioServers: readonly StdioServer[],
    private readonly explicitServers: readonly ExplicitServerClient[]
  ) {}

  async listToolsetsWithErrors(): Promise<McpToolsetsWithErrors> {
    const toolsets: Record<string, ToolsInput> = {};
    const errors: Record<string, string> = {};
    await Promise.all([
      this.discoverStdio(toolsets, errors),
      ...this.explicitServers.map((entry) => this.discoverHttp(entry, toolsets, errors)),
    ]);
    return { errors, toolsets };
  }

  async disconnect(): Promise<void> {
    const operations = [
      ...(this.mastraClient
        ? [{ close: () => this.mastraClient?.disconnect(), serverName: 'stdio' }]
        : []),
      ...this.explicitServers.map(({ client, server }) => ({
        close: () => client.close(),
        serverName: server.name,
      })),
    ];
    const results = await Promise.allSettled(operations.map(({ close }) => close()));
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') {
        continue;
      }
      logger.warn('MCP client disconnect failed', {
        error: result.reason,
        serverName: operations[index]?.serverName ?? 'unknown',
      });
    }
  }

  private async discoverStdio(
    toolsets: Record<string, ToolsInput>,
    errors: Record<string, string>
  ): Promise<void> {
    if (!this.mastraClient) {
      return;
    }
    try {
      const discovered = await this.mastraClient.listToolsetsWithErrors();
      copyOwnEntries(toolsets, discovered.toolsets);
      copyOwnEntries(errors, discovered.errors);
    } catch (error) {
      const reason = errorMessage(error);
      for (const server of this.stdioServers) {
        defineOwn(errors, server.name, reason);
      }
    }
  }

  private async discoverHttp(
    entry: ExplicitServerClient,
    toolsets: Record<string, ToolsInput>,
    errors: Record<string, string>
  ): Promise<void> {
    try {
      const { tools } = await entry.client.listTools();
      defineOwn(toolsets, entry.server.name, convertHttpTools(entry, tools));
    } catch (error) {
      defineOwn(errors, entry.server.name, errorMessage(error));
    }
  }
}

function convertHttpTools(entry: ExplicitServerClient, tools: ExplicitHttpMcpTool[]): ToolsInput {
  const converted: ToolsInput = {};
  for (const tool of tools) {
    defineOwn(converted, tool.name, createHttpTool(entry, tool));
  }
  return converted;
}

function createHttpTool(
  { client, server }: ExplicitServerClient,
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

  return createTool({
    description: tool.description ?? '',
    id: `${server.name}_${tool.name}`,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema
      ? { outputSchema: createDocumentationOnlyMcpOutputSchema(tool.outputSchema) }
      : {}),
    ...(mcp ? { mcp } : {}),
    ...(strict === undefined ? {} : { strict }),
    execute: async (input, context) =>
      executeHttpTool(client, server.name, tool.name, requireToolArguments(input), context),
    mcpMetadata: { serverName: server.name },
  });
}

/**
 * Match Mastra MCPClient 1.13's ownership boundary: the official MCP SDK has
 * already validated structuredContent against the advertised output schema.
 * Mastra still needs the JSON schema for discovery/documentation, but must not
 * re-validate the complete CallToolResult envelope against the inner schema.
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

async function executeHttpTool(
  client: ExplicitHttpMcpClientLike,
  serverName: string,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<unknown> {
  let progressWrites = Promise.resolve();
  let progressDeliveryError: unknown;
  const toolCallId = context?.agent?.toolCallId;
  const writer = context?.writer;
  const onprogress: NonNullable<ExplicitHttpMcpRequestOptions['onprogress']> | undefined =
    toolCallId && writer
      ? (progress): void => {
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
  try {
    result = await client.callTool(
      {
        arguments: input,
        name: toolName,
        ...(requestMeta ? { _meta: requestMeta } : {}),
      },
      {
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
        ...(onprogress ? { onprogress } : {}),
      }
    );
  } catch (error) {
    await finishProgressDelivery();
    throw error;
  }
  await finishProgressDelivery();

  if (result.isError) {
    throw new Error(extractMcpToolError(result));
  }
  if (result.structuredContent === undefined) {
    return result;
  }
  if (readMcpMultimodalOutput(result)) {
    return result;
  }
  return result.structuredContent;
}

function readToolCallMeta(context: ToolExecutionContext): Record<string, unknown> | undefined {
  const meta = (context as ToolExecutionContext & { _meta?: unknown })._meta;
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

function copyOwnEntries<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const [key, value] of Object.entries(source)) {
    defineOwn(target, key, value);
  }
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
