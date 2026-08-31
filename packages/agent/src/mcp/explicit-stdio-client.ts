import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpClientExtensionRegistry } from './client-extension-registry';
import {
  createMcpResponseCacheStore,
  normalizeMcpCachePartition,
  normalizeMcpListMaxPages,
  normalizeMcpRequestOptions,
} from './client-policy';
import { type McpProtocol, toMcpVersionNegotiation } from './config';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpInputRequiredResult,
  ExplicitHttpMcpListToolsParams,
  ExplicitHttpMcpListToolsResult,
  ExplicitHttpMcpRequestOptions,
  ExplicitHttpMcpTool,
  NegotiatedProtocolFacts,
} from './explicit-http-client';
import { notifyUnexpectedClose } from './unexpected-close-observer';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CLOSED_ERROR_MESSAGE = 'Explicit stdio MCP client is closed';
const DISCONNECTED_DURING_CONNECT_ERROR_MESSAGE =
  'MCP stdio connection closed during initialization';
// The SDK 2.0.0 public API requires a numeric request timeout. This is the
// platform maximum timer value, used only for the human-paced auth handshake;
// cancellation remains signal-driven through the transport/client lifecycle.
const USER_PACED_AUTH_SDK_TIMEOUT_MS = 2_147_483_647;

export type ExplicitStdioMcpCallToolParams = ExplicitHttpMcpCallToolParams;
export type ExplicitStdioMcpCallToolResult = ExplicitHttpMcpCallToolResult;
export type ExplicitStdioMcpListToolsParams = ExplicitHttpMcpListToolsParams;
export type ExplicitStdioMcpListToolsResult = ExplicitHttpMcpListToolsResult;
export type ExplicitStdioMcpRequestOptions = ExplicitHttpMcpRequestOptions;
type ExplicitStdioMcpManualCallOptions = ExplicitStdioMcpRequestOptions & {
  allowInputRequired: true;
};
type ExplicitStdioMcpNormalCallOptions = Omit<
  ExplicitStdioMcpRequestOptions,
  'allowInputRequired'
> & {
  allowInputRequired?: false;
};

export interface ExplicitStdioMcpClientOptions {
  args?: readonly string[];
  cachePartition?: ClientOptions['cachePartition'];
  clientInfo?: {
    name: string;
    version: string;
  };
  command: string;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  env?: Readonly<Record<string, string>>;
  extensionRegistry?: McpClientExtensionRegistry;
  listMaxPages?: ClientOptions['listMaxPages'];
  name: string;
  onStderr?: (chunk: string) => void;
  onUnexpectedClose?: () => void;
  protocol?: McpProtocol;
  responseCacheStore?: ClientOptions['responseCacheStore'];
  userPacedAuth?: boolean;
}

interface ActiveConnection {
  client: Client;
  disconnected: boolean;
  removeStderrListener(): void;
  toolDefinitions: ReadonlyMap<string, ExplicitHttpMcpTool>;
  toolMetadataReady: boolean;
  toolMetadataRequest: Promise<ExplicitStdioMcpListToolsResult> | undefined;
  transport: StdioClientTransport;
}

interface NormalizedClientOptions {
  args?: string[];
  cachePartition?: ClientOptions['cachePartition'];
  clientInfo: {
    name: string;
    version: string;
  };
  command: string;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  env?: Record<string, string>;
  extensionRegistry?: McpClientExtensionRegistry;
  listMaxPages: number;
  onStderr?: (chunk: string) => void;
  onUnexpectedClose?: () => void;
  protocol: McpProtocol;
  responseCacheStore: NonNullable<ClientOptions['responseCacheStore']>;
  userPacedAuth: boolean;
}

function closedClientError(): Error {
  return new Error(CLOSED_ERROR_MESSAGE);
}

function validateNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

function normalizeOptions(options: ExplicitStdioMcpClientOptions): NormalizedClientOptions {
  const name = validateNonEmpty(options.name, 'MCP client name');
  const clientInfo = options.clientInfo ?? {
    name: `brainstrike-${name}`,
    version: DEFAULT_CLIENT_VERSION,
  };
  validateNonEmpty(clientInfo.name, 'MCP client info name');
  validateNonEmpty(clientInfo.version, 'MCP client info version');
  const protocol = options.protocol ?? 'legacy';
  if (options.userPacedAuth && protocol !== 'legacy') {
    throw new Error('MCP user-paced stdio authorization requires legacy protocol policy');
  }

  const cachePartition = normalizeMcpCachePartition(
    options.cachePartition,
    options.responseCacheStore !== undefined
  );
  return {
    clientInfo: { ...clientInfo },
    ...(cachePartition === undefined ? {} : { cachePartition }),
    command: validateNonEmpty(options.command, 'MCP stdio command'),
    ...(options.defaultCacheTtlMs === undefined
      ? {}
      : { defaultCacheTtlMs: options.defaultCacheTtlMs }),
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    listMaxPages: normalizeMcpListMaxPages(options.listMaxPages),
    ...(options.onUnexpectedClose ? { onUnexpectedClose: options.onUnexpectedClose } : {}),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    protocol,
    responseCacheStore: createMcpResponseCacheStore(options.responseCacheStore),
    userPacedAuth: options.userPacedAuth ?? false,
  };
}

/**
 * Protocol-faithful MCP stdio client backed directly by the official SDK.
 *
 * Connections are lazy and concurrency-safe. Closing is terminal and
 * idempotent. Failed spawns and interrupted requests remain visible; only a
 * later operation may retry or reconnect with a fresh SDK client/transport
 * pair.
 */
export class ExplicitStdioMcpClient implements NegotiatedProtocolFacts {
  private activeConnection: ActiveConnection | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private connectPromise: Promise<ActiveConnection> | undefined;
  private readonly options: NormalizedClientOptions;
  private pendingConnection: ActiveConnection | undefined;

  constructor(options: ExplicitStdioMcpClientOptions) {
    this.options = normalizeOptions(options);
  }

  async connect(options?: ExplicitStdioMcpRequestOptions): Promise<void> {
    const requestOptions = this.options.userPacedAuth
      ? { ...(options ?? {}), timeout: options?.timeout ?? USER_PACED_AUTH_SDK_TIMEOUT_MS }
      : normalizeMcpRequestOptions(options);
    await this.getConnection(requestOptions);
  }

  getNegotiatedProtocolVersion(): ReturnType<Client['getNegotiatedProtocolVersion']> {
    return this.activeConnection?.client.getNegotiatedProtocolVersion();
  }

  getProtocolEra(): ReturnType<Client['getProtocolEra']> {
    return this.activeConnection?.client.getProtocolEra();
  }

  getServerCapabilities(): ReturnType<Client['getServerCapabilities']> {
    return this.activeConnection?.client.getServerCapabilities();
  }

  getServerVersion(): ReturnType<Client['getServerVersion']> {
    return this.activeConnection?.client.getServerVersion();
  }

  async listTools(
    options?: ExplicitStdioMcpRequestOptions,
    params?: ExplicitStdioMcpListToolsParams
  ): Promise<ExplicitStdioMcpListToolsResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    if (!params) {
      return this.refreshToolMetadata(connection, requestOptions);
    }
    const result = await connection.client.listTools(params, requestOptions);
    if (params.cursor === undefined) {
      this.replaceToolMetadata(connection, result);
    }
    return result;
  }

  async callTool(
    params: ExplicitStdioMcpCallToolParams,
    options: ExplicitStdioMcpManualCallOptions
  ): Promise<ExplicitStdioMcpCallToolResult | ExplicitHttpMcpInputRequiredResult>;
  async callTool(
    params: ExplicitStdioMcpCallToolParams,
    options?: ExplicitStdioMcpNormalCallOptions
  ): Promise<ExplicitStdioMcpCallToolResult>;
  async callTool(
    params: ExplicitStdioMcpCallToolParams,
    options?: ExplicitStdioMcpManualCallOptions | ExplicitStdioMcpNormalCallOptions
  ): Promise<ExplicitStdioMcpCallToolResult | ExplicitHttpMcpInputRequiredResult> {
    const normalizedOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(normalizedOptions);
    if (!connection.toolMetadataReady) {
      await this.refreshToolMetadata(connection, normalizedOptions);
    }
    const toolDefinition =
      normalizedOptions.toolDefinition === undefined
        ? connection.toolDefinitions.get(params.name)
        : undefined;
    const requestOptions =
      toolDefinition === undefined ? normalizedOptions : { ...normalizedOptions, toolDefinition };
    return connection.client.callTool(params, requestOptions);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.closeConnections();
    return this.closePromise;
  }

  private async closeConnections(): Promise<void> {
    const connectionSettled = this.connectPromise?.catch(() => undefined);
    const connections = new Set<ActiveConnection>();
    if (this.activeConnection) {
      connections.add(this.activeConnection);
    }
    if (this.pendingConnection) {
      connections.add(this.pendingConnection);
    }
    this.activeConnection = undefined;
    this.pendingConnection = undefined;
    this.connectPromise = undefined;

    const results = await Promise.allSettled(
      [...connections].flatMap(({ client, transport }) => [transport.close(), client.close()])
    );
    for (const connection of connections) {
      connection.removeStderrListener();
    }
    await connectionSettled;
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Closing MCP stdio clients failed');
    }
  }

  private getConnection(options?: ExplicitStdioMcpRequestOptions): Promise<ActiveConnection> {
    if (this.closed) {
      return Promise.reject(closedClientError());
    }
    if (this.activeConnection) {
      return Promise.resolve(this.activeConnection);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    return this.startConnection(options);
  }

  private startConnection(options?: ExplicitStdioMcpRequestOptions): Promise<ActiveConnection> {
    const connection = this.createConnection();
    // Publish ownership before connect starts so terminal close always owns and reaps this child.
    this.pendingConnection = connection;
    const connectPromise = this.openConnection(connection, options);
    this.connectPromise = connectPromise;
    void connectPromise.then(
      () => {
        if (this.connectPromise !== connectPromise) {
          return;
        }
        this.pendingConnection = undefined;
        if (this.closed || connection.disconnected) {
          this.connectPromise = undefined;
          return;
        }
        this.activeConnection = connection;
        this.connectPromise = undefined;
      },
      () => {
        if (this.connectPromise === connectPromise) {
          this.pendingConnection = undefined;
          this.connectPromise = undefined;
        }
      }
    );
    return connectPromise;
  }

  private async openConnection(
    connection: ActiveConnection,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ActiveConnection> {
    let connected = false;
    try {
      await connection.client.connect(connection.transport, options);
      connected = true;
      if (this.closed) {
        throw closedClientError();
      }
      if (connection.disconnected) {
        throw new Error(DISCONNECTED_DURING_CONNECT_ERROR_MESSAGE);
      }
      return connection;
    } catch (error) {
      if (!connected) {
        await connection.client.close().catch(() => undefined);
        connection.removeStderrListener();
      }
      throw error;
    }
  }

  private createConnection(): ActiveConnection {
    const extensions = this.options.extensionRegistry?.toClientExtensionCapabilities();
    const clientOptions: ClientOptions = {
      capabilities: extensions ? { extensions } : {},
      listMaxPages: this.options.listMaxPages,
      versionNegotiation: toMcpVersionNegotiation(this.options.protocol),
      ...(this.options.cachePartition === undefined
        ? {}
        : { cachePartition: this.options.cachePartition }),
      ...(this.options.defaultCacheTtlMs === undefined
        ? {}
        : { defaultCacheTtlMs: this.options.defaultCacheTtlMs }),
      responseCacheStore: this.options.responseCacheStore,
    };
    const client = new Client(this.options.clientInfo, clientOptions);
    const transport = new StdioClientTransport({
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.onStderr ? { stderr: 'pipe' as const } : {}),
    });
    const stderr = transport.stderr;
    const onStderrData = (chunk: unknown) => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
      this.options.onStderr?.(text);
    };
    if (this.options.onStderr) {
      if (!stderr) {
        throw new Error('MCP stdio stderr pipe was requested but unavailable');
      }
      stderr.on('data', onStderrData);
    }
    const connection: ActiveConnection = {
      client,
      disconnected: false,
      removeStderrListener: () => stderr?.off('data', onStderrData),
      toolDefinitions: new Map(),
      toolMetadataReady: false,
      toolMetadataRequest: undefined,
      transport,
    };
    client.onclose = () => this.invalidateConnection(connection);
    return connection;
  }

  private invalidateConnection(connection: ActiveConnection): void {
    if (connection.disconnected) {
      return;
    }
    // close() sets closed before teardown. Pending failures reject connect directly; only an
    // established active connection notifies the observer.
    const unexpected = !this.closed && this.activeConnection === connection;
    connection.disconnected = true;
    connection.toolDefinitions = new Map();
    connection.toolMetadataReady = false;
    connection.toolMetadataRequest = undefined;
    if (this.activeConnection === connection) {
      this.activeConnection = undefined;
    }
    if (this.pendingConnection === connection) {
      this.pendingConnection = undefined;
    }
    if (unexpected) {
      notifyUnexpectedClose(this.options.onUnexpectedClose, 'stdio');
    }
  }

  private refreshToolMetadata(
    connection: ActiveConnection,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpListToolsResult> {
    if (connection.toolMetadataRequest) {
      return connection.toolMetadataRequest;
    }
    const request = connection.client.listTools(undefined, options);
    const metadataRequest = request.then((result) => {
      this.replaceToolMetadata(connection, result);
      return result;
    });
    connection.toolMetadataRequest = metadataRequest;
    const clearRequest = (): void => {
      if (connection.toolMetadataRequest === metadataRequest) {
        connection.toolMetadataRequest = undefined;
      }
    };
    void metadataRequest.then(clearRequest, clearRequest);
    return metadataRequest;
  }

  private replaceToolMetadata(
    connection: ActiveConnection,
    result: ExplicitStdioMcpListToolsResult
  ): void {
    if (connection.disconnected) {
      return;
    }
    connection.toolDefinitions = new Map(result.tools.map((tool) => [tool.name, tool]));
    connection.toolMetadataReady = true;
  }
}
