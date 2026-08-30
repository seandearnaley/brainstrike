import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpClientExtensionRegistry } from './client-extension-registry';
import { type McpProtocol, toMcpVersionNegotiation } from './config';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpListToolsParams,
  ExplicitHttpMcpListToolsResult,
  ExplicitHttpMcpRequestOptions,
  NegotiatedProtocolFacts,
} from './explicit-http-client';
import { notifyUnexpectedClose } from './unexpected-close-observer';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CLOSED_ERROR_MESSAGE = 'Explicit stdio MCP client is closed';
const DISCONNECTED_DURING_CONNECT_ERROR_MESSAGE =
  'MCP stdio connection closed during initialization';

export type ExplicitStdioMcpCallToolParams = ExplicitHttpMcpCallToolParams;
export type ExplicitStdioMcpCallToolResult = ExplicitHttpMcpCallToolResult;
export type ExplicitStdioMcpListToolsParams = ExplicitHttpMcpListToolsParams;
export type ExplicitStdioMcpListToolsResult = ExplicitHttpMcpListToolsResult;
export type ExplicitStdioMcpRequestOptions = ExplicitHttpMcpRequestOptions;

export interface ExplicitStdioMcpClientOptions {
  args?: readonly string[];
  clientInfo?: {
    name: string;
    version: string;
  };
  command: string;
  env?: Readonly<Record<string, string>>;
  extensionRegistry?: McpClientExtensionRegistry;
  name: string;
  onUnexpectedClose?: () => void;
  protocol?: McpProtocol;
}

interface ActiveConnection {
  client: Client;
  disconnected: boolean;
  toolMetadataReady: boolean;
  toolMetadataRequest: Promise<ExplicitStdioMcpListToolsResult> | undefined;
  transport: StdioClientTransport;
}

interface NormalizedClientOptions {
  args?: string[];
  clientInfo: {
    name: string;
    version: string;
  };
  command: string;
  env?: Record<string, string>;
  extensionRegistry?: McpClientExtensionRegistry;
  onUnexpectedClose?: () => void;
  protocol: McpProtocol;
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

  return {
    clientInfo: { ...clientInfo },
    command: validateNonEmpty(options.command, 'MCP stdio command'),
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    ...(options.onUnexpectedClose ? { onUnexpectedClose: options.onUnexpectedClose } : {}),
    protocol: options.protocol ?? 'legacy',
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
    await this.getConnection(options);
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
    const connection = await this.getConnection(options);
    if (!params) {
      return this.refreshToolMetadata(connection, options);
    }
    const result = await connection.client.listTools(params, options);
    if (params.cursor === undefined) {
      connection.toolMetadataReady = true;
    }
    return result;
  }

  async callTool(
    params: ExplicitStdioMcpCallToolParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpCallToolResult> {
    const connection = await this.getConnection(options);
    if (!connection.toolMetadataReady) {
      await this.refreshToolMetadata(connection, options);
    }
    return connection.client.callTool(params, options);
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
      }
      throw error;
    }
  }

  private createConnection(): ActiveConnection {
    const extensions = this.options.extensionRegistry?.toClientExtensionCapabilities();
    const client = new Client(this.options.clientInfo, {
      capabilities: extensions ? { extensions } : {},
      versionNegotiation: toMcpVersionNegotiation(this.options.protocol),
    });
    const transport = new StdioClientTransport({
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const connection: ActiveConnection = {
      client,
      disconnected: false,
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
    connection.toolMetadataRequest = request;
    void request.then(
      () => {
        connection.toolMetadataReady = true;
        if (connection.toolMetadataRequest === request) {
          connection.toolMetadataRequest = undefined;
        }
      },
      () => {
        if (connection.toolMetadataRequest === request) {
          connection.toolMetadataRequest = undefined;
        }
      }
    );
    return request;
  }
}
