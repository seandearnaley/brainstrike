import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CLOSED_ERROR_MESSAGE = 'Explicit HTTP MCP client is closed';
// Session termination is advisory. Bound it so a stalled server cannot prevent
// the owned SDK client from aborting its local fetches and releasing handlers.
const SESSION_TERMINATION_TIMEOUT_MS = 250;
const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const PROTOCOL_OWNED_HEADERS = new Set([
  'accept',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
]);

export type ExplicitHttpMcpTransport = 'sse' | 'streamable-http';

export type ExplicitHttpMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

type SdkRequestOptions = NonNullable<Parameters<Client['listTools']>[1]>;
type SdkTransport = Parameters<Client['connect']>[0];

export type ExplicitHttpMcpRequestOptions = Pick<
  SdkRequestOptions,
  'maxTotalTimeout' | 'onprogress' | 'resetTimeoutOnProgress' | 'signal' | 'timeout'
>;

export type ExplicitHttpMcpListToolsResult = Awaited<ReturnType<Client['listTools']>>;
export type ExplicitHttpMcpTool = ExplicitHttpMcpListToolsResult['tools'][number];
export type ExplicitHttpMcpCallToolParams = Parameters<Client['callTool']>[0];
export type ExplicitHttpMcpCallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface ExplicitHttpMcpClientOptions {
  clientInfo?: {
    name: string;
    version: string;
  };
  fetch?: ExplicitHttpMcpFetch;
  headers?: Readonly<Record<string, string>>;
  name: string;
  transport: ExplicitHttpMcpTransport;
  url: string | URL;
}

type ExplicitHttpTransport = SSEClientTransport | StreamableHTTPClientTransport;

interface ActiveConnection {
  client: Client;
  transport: ExplicitHttpTransport;
}

interface NormalizedClientOptions {
  clientInfo: {
    name: string;
    version: string;
  };
  fetch: ExplicitHttpMcpFetch;
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

function validateConfiguredHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (PROTOCOL_OWNED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Configured MCP header "${name}" is protocol-owned`);
    }
  }
}

function isReconnectableSessionError(error: unknown, hadSession: boolean): boolean {
  return hadSession && error instanceof StreamableHTTPError && error.code === 404;
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
    fetch: createHeaderPreservingFetch(baseFetch, options.headers),
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
export class ExplicitHttpMcpClient {
  private activeConnection: ActiveConnection | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private connectPromise: Promise<ActiveConnection> | undefined;
  private readonly options: NormalizedClientOptions;
  private pendingConnection: ActiveConnection | undefined;
  private recoveryPromise: Promise<ActiveConnection> | undefined;

  constructor(options: ExplicitHttpMcpClientOptions) {
    this.options = normalizeOptions(options);
  }

  async connect(options?: ExplicitHttpMcpRequestOptions): Promise<void> {
    await this.getConnection(options);
  }

  async listTools(
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpListToolsResult> {
    return this.runWithSessionRecovery((client) => client.listTools(undefined, options), options);
  }

  async callTool(
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpCallToolResult> {
    return this.runWithSessionRecovery(
      (client) => client.callTool(params, undefined, options),
      options
    );
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
    this.activeConnection = undefined;
    this.pendingConnection = undefined;
    this.connectPromise = undefined;
    this.recoveryPromise = undefined;

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
        if (this.closed) {
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
      // SDK 1.29.0's concrete Streamable transport exposes `sessionId` as
      // `string | undefined`, while its Transport interface models the optional
      // property as present-only `string` under exactOptionalPropertyTypes.
      // The shipped class is the intended implementation despite that d.ts gap.
      await client.connect(transport as unknown as SdkTransport, options);
      connected = true;
      if (this.closed) {
        await client.close();
        throw closedClientError();
      }
      return connection;
    } catch (error) {
      if (!connected) {
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  private async closeConnection(connection: ActiveConnection): Promise<void> {
    const errors: unknown[] = [];
    if (
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
    const client = new Client(this.options.clientInfo, {
      capabilities: {
        extensions: { [MCP_APPS_EXTENSION_ID]: {} },
      },
    });
    return { client, transport: this.createTransport() };
  }

  private async runWithSessionRecovery<T>(
    request: (client: Client) => Promise<T>,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<T> {
    const connection = await this.getConnection(options);
    try {
      return await request(connection.client);
    } catch (error) {
      if (
        this.closed ||
        options?.signal?.aborted ||
        !(connection.transport instanceof StreamableHTTPClientTransport) ||
        !isReconnectableSessionError(error, connection.transport.sessionId !== undefined)
      ) {
        throw error;
      }

      const recovered = await this.recoverConnection(connection, options);
      options?.signal?.throwIfAborted();
      return request(recovered.client);
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
      // The server has already invalidated this session. Close only the local
      // transport; attempting DELETE with the stale ID would delay recovery.
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
