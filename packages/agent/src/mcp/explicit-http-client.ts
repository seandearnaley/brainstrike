import {
  Client,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpClientExtensionRegistry } from './client-extension-registry';
import { type McpProtocol, toMcpVersionNegotiation } from './config';
import {
  diagnoseInvalidatedCloseFailure,
  notifyUnexpectedClose,
} from './unexpected-close-observer';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CLOSED_ERROR_MESSAGE = 'Explicit HTTP MCP client is closed';
// Session termination is advisory. Bound it so a stalled server cannot prevent
// the owned SDK client from aborting its local fetches and releasing handlers.
const SESSION_TERMINATION_TIMEOUT_MS = 250;
const PROTOCOL_OWNED_HEADERS = new Set([
  'accept',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
]);

export type ExplicitHttpMcpTransport = 'sse' | 'streamable-http';
export type ExplicitHttpMcpLifecycle = 'client-owned' | 'host-owned';
export type ExplicitHttpMcpUnexpectedCloseObserver = () => void | Promise<void>;

export type ExplicitHttpMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

type SdkRequestOptions = NonNullable<Parameters<Client['listTools']>[1]>;
export interface ExplicitHttpMcpRequestOptions {
  maxTotalTimeout?: NonNullable<SdkRequestOptions['maxTotalTimeout']>;
  onprogress?: NonNullable<SdkRequestOptions['onprogress']>;
  resetTimeoutOnProgress?: NonNullable<SdkRequestOptions['resetTimeoutOnProgress']>;
  signal?: NonNullable<SdkRequestOptions['signal']>;
  timeout?: NonNullable<SdkRequestOptions['timeout']>;
}

export type ExplicitHttpMcpListToolsResult = Awaited<ReturnType<Client['listTools']>>;
export type ExplicitHttpMcpListToolsParams = NonNullable<Parameters<Client['listTools']>[0]>;
export type ExplicitHttpMcpTool = ExplicitHttpMcpListToolsResult['tools'][number];
export type ExplicitHttpMcpCallToolParams = Parameters<Client['callTool']>[0];
export type ExplicitHttpMcpCallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface NegotiatedProtocolFacts {
  getNegotiatedProtocolVersion: () => ReturnType<Client['getNegotiatedProtocolVersion']>;
  getProtocolEra: () => ReturnType<Client['getProtocolEra']>;
  getServerCapabilities: () => ReturnType<Client['getServerCapabilities']>;
  getServerVersion: () => ReturnType<Client['getServerVersion']>;
}

export interface ExplicitHttpMcpClientOptions {
  clientInfo?: {
    name: string;
    version: string;
  };
  extensionRegistry?: McpClientExtensionRegistry;
  fetch?: ExplicitHttpMcpFetch;
  headers?: Readonly<Record<string, string>>;
  lifecycle?: ExplicitHttpMcpLifecycle;
  name: string;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol?: McpProtocol;
  transport: ExplicitHttpMcpTransport;
  url: string | URL;
}

type ExplicitHttpTransport = SSEClientTransport | StreamableHTTPClientTransport;

interface ActiveConnection {
  client: Client;
  disconnected: boolean;
  transport: ExplicitHttpTransport;
}

interface NormalizedClientOptions {
  clientInfo: {
    name: string;
    version: string;
  };
  extensionRegistry?: McpClientExtensionRegistry;
  fetch: ExplicitHttpMcpFetch;
  lifecycle: ExplicitHttpMcpLifecycle;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol: McpProtocol;
  transport: ExplicitHttpMcpTransport;
  url: URL;
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

function validateLifecycle(value: unknown, clientName: string): ExplicitHttpMcpLifecycle {
  const lifecycle = value ?? 'client-owned';
  if (lifecycle !== 'client-owned' && lifecycle !== 'host-owned') {
    throw new Error(
      `MCP client "${clientName}": lifecycle must be "client-owned" or "host-owned" (got "${String(lifecycle)}")`
    );
  }
  return lifecycle;
}

function validateUnexpectedCloseObserver(
  value: unknown,
  clientName: string
): ExplicitHttpMcpUnexpectedCloseObserver | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw new Error(`MCP client "${clientName}": onUnexpectedClose must be a function`);
  }
  return value as ExplicitHttpMcpUnexpectedCloseObserver;
}

function validateConfiguredHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (PROTOCOL_OWNED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Configured MCP header "${name}" is protocol-owned`);
    }
  }
}

function isReconnectableSessionError(error: unknown, hadSession: boolean): boolean {
  return hadSession && error instanceof SdkHttpError && error.status === 404;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createHeaderPreservingFetch(
  baseFetch: ExplicitHttpMcpFetch,
  headers: Readonly<Record<string, string>> | undefined
): ExplicitHttpMcpFetch {
  validateConfiguredHeaders(headers);
  const callerHeaders = new Headers(headers);
  return async (url, init) => {
    const mergedHeaders = new Headers(callerHeaders);
    const protocolHeaders = new Headers(init?.headers);
    protocolHeaders.forEach((value, name) => {
      const configuredValue = mergedHeaders.get(name);
      if (configuredValue !== null && configuredValue !== value) {
        throw new Error(
          `Configured MCP header "${name}" conflicts with the transport-required value`
        );
      }
      mergedHeaders.set(name, value);
    });
    return baseFetch(url, { ...init, headers: mergedHeaders });
  };
}

function normalizeOptions(options: ExplicitHttpMcpClientOptions): NormalizedClientOptions {
  const name = validateNonEmpty(options.name, 'MCP client name');
  const onUnexpectedClose = validateUnexpectedCloseObserver(options.onUnexpectedClose, name);
  const protocol = options.protocol ?? 'legacy';
  if (options.transport === 'sse' && protocol !== 'legacy') {
    throw new Error(
      `MCP client "${name}": legacy SSE transport requires protocol "legacy" (got "${protocol}")`
    );
  }
  const clientInfo = options.clientInfo ?? {
    name: `brainstrike-${name}`,
    version: DEFAULT_CLIENT_VERSION,
  };
  validateNonEmpty(clientInfo.name, 'MCP client info name');
  validateNonEmpty(clientInfo.version, 'MCP client info version');

  const url = new URL(options.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP HTTP URL must use http: or https:');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('MCP HTTP URL must not include credentials');
  }

  const baseFetch: ExplicitHttpMcpFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    clientInfo: { ...clientInfo },
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    fetch: createHeaderPreservingFetch(baseFetch, options.headers),
    lifecycle: validateLifecycle(options.lifecycle, name),
    ...(onUnexpectedClose ? { onUnexpectedClose } : {}),
    protocol,
    transport: options.transport,
    url,
  };
}

function unsupportedTransport(transport: never): never {
  throw new Error(`Unsupported explicit HTTP MCP transport: ${String(transport)}`);
}

/**
 * Protocol-faithful MCP client for an explicitly selected remote HTTP transport.
 *
 * The selected transport is authoritative: this class never probes, rewrites the
 * URL, or falls back between Streamable HTTP and legacy HTTP+SSE.
 */
export class ExplicitHttpMcpClient implements NegotiatedProtocolFacts {
  private activeConnection: ActiveConnection | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private connectPromise: Promise<ActiveConnection> | undefined;
  private readonly invalidatedConnections = new Set<ActiveConnection>();
  private readonly options: NormalizedClientOptions;
  private pendingConnection: ActiveConnection | undefined;
  private recoveryPromise: Promise<ActiveConnection> | undefined;

  constructor(options: ExplicitHttpMcpClientOptions) {
    this.options = normalizeOptions(options);
  }

  async connect(options?: ExplicitHttpMcpRequestOptions): Promise<void> {
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
    options?: ExplicitHttpMcpRequestOptions,
    params?: ExplicitHttpMcpListToolsParams
  ): Promise<ExplicitHttpMcpListToolsResult> {
    return this.runRequest((client) => client.listTools(params, options), options);
  }

  async callTool(
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpCallToolResult> {
    return this.runRequest((client) => client.callTool(params, options), options);
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
    const connections = new Set<ActiveConnection>();
    if (this.activeConnection) {
      connections.add(this.activeConnection);
    }
    if (this.pendingConnection) {
      connections.add(this.pendingConnection);
    }
    for (const connection of this.invalidatedConnections) {
      connections.add(connection);
    }
    this.activeConnection = undefined;
    this.pendingConnection = undefined;
    this.connectPromise = undefined;
    this.recoveryPromise = undefined;
    this.invalidatedConnections.clear();

    const errors: unknown[] = [];
    for (const connection of connections) {
      try {
        await this.closeConnection(connection);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Closing MCP HTTP connections failed');
    }
  }

  private async getConnection(options?: ExplicitHttpMcpRequestOptions): Promise<ActiveConnection> {
    if (this.closed) {
      throw closedClientError();
    }
    if (this.activeConnection) {
      return this.activeConnection;
    }
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    return this.startConnection(options);
  }

  private startConnection(options?: ExplicitHttpMcpRequestOptions): Promise<ActiveConnection> {
    const connection = this.createConnection();
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
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ActiveConnection> {
    const { client, transport } = connection;
    let connected = false;
    try {
      await client.connect(transport, options);
      connected = true;
      if (this.closed) {
        if (!this.closePromise) {
          throw new Error('Explicit HTTP MCP terminal close invariant violated');
        }
        await this.closePromise;
        throw closedClientError();
      }
      if (connection.disconnected) {
        throw new Error('MCP HTTP connection closed during initialization');
      }
      return connection;
    } catch (error) {
      if (!connected) {
        await client.close().catch(() => undefined);
      }
      options?.signal?.throwIfAborted();
      throw error;
    }
  }

  private async closeConnection(connection: ActiveConnection): Promise<void> {
    const errors: unknown[] = [];
    if (
      !connection.disconnected &&
      connection.transport instanceof StreamableHTTPClientTransport &&
      connection.transport.sessionId
    ) {
      try {
        await withTimeout(
          connection.transport.terminateSession(),
          SESSION_TERMINATION_TIMEOUT_MS,
          `MCP session termination timed out after ${SESSION_TERMINATION_TIMEOUT_MS}ms`
        );
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await connection.client.close();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'MCP session termination and local close both failed');
    }
  }

  private createConnection(): ActiveConnection {
    const extensions = this.options.extensionRegistry?.toClientExtensionCapabilities();
    const client = new Client(this.options.clientInfo, {
      capabilities: extensions ? { extensions } : {},
      versionNegotiation: toMcpVersionNegotiation(this.options.protocol),
    });
    const connection = { client, disconnected: false, transport: this.createTransport() };
    client.onclose = () => this.invalidateConnection(connection);
    return connection;
  }

  private async runRequest<T>(
    request: (client: Client) => Promise<T>,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<T> {
    const connection = await this.getConnection(options);
    try {
      return await request(connection.client);
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (this.closed) {
        throw error;
      }
      if (
        connection.transport instanceof StreamableHTTPClientTransport &&
        isReconnectableSessionError(error, connection.transport.sessionId !== undefined)
      ) {
        if (this.options.lifecycle === 'host-owned') {
          if (this.invalidateConnection(connection, true)) {
            await this.closeInvalidatedConnection(connection);
          }
          throw error;
        }
        const recovered = await this.recoverConnection(connection, options);
        options?.signal?.throwIfAborted();
        return request(recovered.client);
      }
      throw error;
    }
  }

  private recoverConnection(
    failedConnection: ActiveConnection,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ActiveConnection> {
    if (this.closed) {
      return Promise.reject(closedClientError());
    }
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    if (this.activeConnection !== failedConnection) {
      return this.getConnection(options);
    }

    this.activeConnection = undefined;
    const recoveryPromise = (async () => {
      await failedConnection.client.close();
      if (this.closed) {
        throw closedClientError();
      }
      options?.signal?.throwIfAborted();
      return this.startConnection(options);
    })();
    this.recoveryPromise = recoveryPromise;
    void recoveryPromise.then(
      () => {
        if (this.recoveryPromise === recoveryPromise) {
          this.recoveryPromise = undefined;
        }
      },
      () => {
        if (this.recoveryPromise === recoveryPromise) {
          this.recoveryPromise = undefined;
        }
      }
    );
    return recoveryPromise;
  }

  private async closeInvalidatedConnection(connection: ActiveConnection): Promise<void> {
    try {
      await connection.client.close();
      this.invalidatedConnections.delete(connection);
    } catch (error) {
      // Keep the failed cleanup in the terminal close set. The host-owned
      // operation must still surface its original transport failure.
      diagnoseInvalidatedCloseFailure(error, this.options.transport);
    }
  }

  private invalidateConnection(
    connection: ActiveConnection,
    retainForLocalCleanup = false
  ): boolean {
    if (connection.disconnected) {
      return false;
    }
    const unexpected = !this.closed && this.activeConnection === connection;
    connection.disconnected = true;
    if (this.activeConnection === connection) {
      this.activeConnection = undefined;
      if (retainForLocalCleanup) {
        this.invalidatedConnections.add(connection);
      }
    }
    if (this.pendingConnection === connection) {
      this.pendingConnection = undefined;
    }
    if (unexpected) {
      notifyUnexpectedClose(this.options.onUnexpectedClose, this.options.transport);
    }
    return true;
  }

  private createTransport(): ExplicitHttpTransport {
    switch (this.options.transport) {
      case 'sse':
        return new SSEClientTransport(this.options.url, { fetch: this.options.fetch });
      case 'streamable-http':
        return new StreamableHTTPClientTransport(this.options.url, {
          fetch: this.options.fetch,
        });
      default:
        return unsupportedTransport(this.options.transport);
    }
  }
}
