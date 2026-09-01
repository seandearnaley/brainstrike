import {
  type AuthProvider,
  Client,
  type ClientOptions,
  type InputRequiredResult,
  type JSONObject,
  type McpSubscription,
  type OAuthClientProvider,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type SubscriptionFilter,
} from '@modelcontextprotocol/client';
import {
  composeMcpTransportCapabilities,
  type McpClientCapabilityLease,
  type McpClientCapabilityOptions,
  type McpClientCapabilityRuntime,
} from './client-capabilities';
import type {
  McpClientExtensionRegistry,
  McpClientExtensionRequestContract,
} from './client-extension-registry';
import {
  createMcpResponseCacheStore,
  normalizeMcpCachePartition,
  normalizeMcpListMaxPages,
  normalizeMcpRequestOptions,
} from './client-policy';
import { type McpProtocol, toMcpVersionNegotiation } from './config';
import { closeOwnedHttpConnection } from './http-connection-cleanup';
import {
  assertOAuthHeaderCompatibility,
  createInteractiveOAuthCompletion,
  type ExplicitHttpMcpAuthorizationCallbackSource,
  type InteractiveOAuthCompletion,
  type InteractiveOAuthOperation,
  normalizeOAuthStepUpOptions,
  tryCompleteInteractiveOAuthRequestAuthorization,
} from './interactive-oauth-completion';
import {
  createHeaderPreservingFetch,
  installRegisteredExtensionDispatch,
} from './registered-extension-dispatch';
import {
  type McpServerFeatureEventDiagnosticSink,
  type McpServerFeatureEventHandlers,
  McpServerFeatureEventRegistry,
  resolveMcpServerFeatureEventDiagnosticSink,
} from './server-feature-events';
import {
  listenForMcpTasks,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
  requireMcpTasksRegistry,
} from './tasks-extension';
import {
  diagnoseInvalidatedCloseFailure,
  notifyUnexpectedClose,
} from './unexpected-close-observer';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CLOSED_ERROR_MESSAGE = 'Explicit HTTP MCP client is closed';

export type ExplicitHttpMcpTransport = 'sse' | 'streamable-http';
export type ExplicitHttpMcpLifecycle = 'client-owned' | 'host-owned';
export type ExplicitHttpMcpUnexpectedCloseObserver = () => void | Promise<void>;

export type ExplicitHttpMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type { ExplicitHttpMcpAuthorizationCallbackSource } from './interactive-oauth-completion';

type SdkRequestOptions = NonNullable<Parameters<Client['callTool']>[1]>;
export type ExplicitHttpMcpRequestOptions = SdkRequestOptions;
type ExplicitHttpMcpListRequestOptions = NonNullable<Parameters<Client['listTools']>[1]>;

export type ExplicitHttpMcpListToolsResult = Awaited<ReturnType<Client['listTools']>>;
export type ExplicitHttpMcpListToolsParams = NonNullable<Parameters<Client['listTools']>[0]>;
export type ExplicitHttpMcpListPromptsResult = Awaited<ReturnType<Client['listPrompts']>>;
export type ExplicitHttpMcpListPromptsParams = NonNullable<Parameters<Client['listPrompts']>[0]>;
export type ExplicitHttpMcpListResourcesResult = Awaited<ReturnType<Client['listResources']>>;
export type ExplicitHttpMcpListResourcesParams = NonNullable<
  Parameters<Client['listResources']>[0]
>;
export type ExplicitHttpMcpListResourceTemplatesResult = Awaited<
  ReturnType<Client['listResourceTemplates']>
>;
export type ExplicitHttpMcpListResourceTemplatesParams = NonNullable<
  Parameters<Client['listResourceTemplates']>[0]
>;
export type ExplicitHttpMcpTool = ExplicitHttpMcpListToolsResult['tools'][number];
export type ExplicitHttpMcpCallToolParams = Parameters<Client['callTool']>[0];
export type ExplicitHttpMcpCallToolResult = Awaited<ReturnType<Client['callTool']>>;
export type ExplicitHttpMcpInputRequiredResult = InputRequiredResult;
export type ExplicitHttpMcpReadResourceParams = Parameters<Client['readResource']>[0];
export type ExplicitHttpMcpReadResourceResult = Awaited<ReturnType<Client['readResource']>>;
export type ExplicitHttpMcpGetPromptParams = Parameters<Client['getPrompt']>[0];
export type ExplicitHttpMcpGetPromptResult = Awaited<ReturnType<Client['getPrompt']>>;
export type ExplicitHttpMcpCompleteParams = Parameters<Client['complete']>[0];
export type ExplicitHttpMcpCompleteResult = Awaited<ReturnType<Client['complete']>>;
export type ExplicitHttpMcpSubscription = McpSubscription;
export type ExplicitHttpMcpSubscriptionFilter = SubscriptionFilter;

type ExplicitHttpMcpManualCallOptions = ExplicitHttpMcpRequestOptions & {
  allowInputRequired: true;
};
type ExplicitHttpMcpNormalCallOptions = Omit<
  ExplicitHttpMcpRequestOptions,
  'allowInputRequired'
> & {
  allowInputRequired?: false;
};

export interface NegotiatedProtocolFacts {
  getNegotiatedProtocolVersion: () => ReturnType<Client['getNegotiatedProtocolVersion']>;
  getProtocolEra: () => ReturnType<Client['getProtocolEra']>;
  getServerCapabilities: () => ReturnType<Client['getServerCapabilities']>;
  getServerVersion: () => ReturnType<Client['getServerVersion']>;
}

export interface ExplicitHttpMcpClientOptions {
  authorizationCallbackSource?: ExplicitHttpMcpAuthorizationCallbackSource;
  authorizationCallbackTimeoutMs?: number;
  authProvider?: AuthProvider | OAuthClientProvider;
  cachePartition?: ClientOptions['cachePartition'];
  clientCapabilities?: McpClientCapabilityOptions;
  clientInfo?: {
    name: string;
    version: string;
  };
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  extensionRegistry?: McpClientExtensionRegistry;
  fetch?: ExplicitHttpMcpFetch;
  headers?: Readonly<Record<string, string>>;
  inputRequired?: ClientOptions['inputRequired'];
  lifecycle?: ExplicitHttpMcpLifecycle;
  listMaxPages?: ClientOptions['listMaxPages'];
  maxStepUpRetries?: number;
  name: string;
  onInsufficientScope?: 'reauthorize' | 'throw';
  onServerFeatureEventError?: McpServerFeatureEventDiagnosticSink;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol?: McpProtocol;
  responseCacheStore?: ClientOptions['responseCacheStore'];
  transport: ExplicitHttpMcpTransport;
  url: string | URL;
}

type ExplicitHttpTransport = SSEClientTransport | StreamableHTTPClientTransport;

interface ActiveConnection {
  capabilityLease: McpClientCapabilityLease;
  client: Client;
  closePromise?: Promise<void>;
  disconnected: boolean;
  generation: number;
  transport: ExplicitHttpTransport;
}

type McpCatalogKind = 'prompts' | 'resource-templates' | 'resources' | 'tools';

interface NormalizedClientOptions {
  authProvider?: AuthProvider | OAuthClientProvider;
  cachePartition?: ClientOptions['cachePartition'];
  capabilityRuntime: McpClientCapabilityRuntime;
  clientInfo: {
    name: string;
    version: string;
  };
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  extensionRegistry?: McpClientExtensionRegistry;
  fetch: ExplicitHttpMcpFetch;
  inputRequired: NonNullable<ClientOptions['inputRequired']>;
  interactiveOAuth?: InteractiveOAuthCompletion;
  lifecycle: ExplicitHttpMcpLifecycle;
  listMaxPages: number;
  maxStepUpRetries?: number;
  onInsufficientScope?: 'reauthorize' | 'throw';
  onServerFeatureEventError: McpServerFeatureEventDiagnosticSink;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol: McpProtocol;
  responseCacheStore: NonNullable<ClientOptions['responseCacheStore']>;
  serverName: string;
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

function isReconnectableSessionError(error: unknown, hadSession: boolean): boolean {
  return hadSession && error instanceof SdkHttpError && error.status === 404;
}

function normalizeOptions(options: ExplicitHttpMcpClientOptions): NormalizedClientOptions {
  const name = validateNonEmpty(options.name, 'MCP client name');
  const interactiveOAuth = createInteractiveOAuthCompletion(name, options);
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
  const cachePartition = normalizeMcpCachePartition(
    options.cachePartition,
    options.responseCacheStore !== undefined
  );
  assertOAuthHeaderCompatibility(name, options.authProvider, options.headers);
  const scopeStepUp = normalizeOAuthStepUpOptions(options);
  const capabilityConfiguration = composeMcpTransportCapabilities({
    ...(options.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {}),
    ...(options.inputRequired ? { inputRequired: options.inputRequired } : {}),
  });
  return {
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    ...(cachePartition === undefined ? {} : { cachePartition }),
    capabilityRuntime: capabilityConfiguration.runtime,
    clientInfo: { ...clientInfo },
    ...(options.defaultCacheTtlMs === undefined
      ? {}
      : { defaultCacheTtlMs: options.defaultCacheTtlMs }),
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    fetch: createHeaderPreservingFetch(baseFetch, options.headers, options.extensionRegistry, () =>
      interactiveOAuth?.getAuthorizationSignal()
    ),
    inputRequired: capabilityConfiguration.inputRequired,
    ...(interactiveOAuth ? { interactiveOAuth } : {}),
    lifecycle: validateLifecycle(options.lifecycle, name),
    listMaxPages: normalizeMcpListMaxPages(options.listMaxPages),
    onServerFeatureEventError: resolveMcpServerFeatureEventDiagnosticSink(
      options.onServerFeatureEventError,
      name
    ),
    ...scopeStepUp,
    ...(onUnexpectedClose ? { onUnexpectedClose } : {}),
    protocol,
    responseCacheStore: createMcpResponseCacheStore(options.responseCacheStore),
    serverName: name,
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
  private readonly featureEvents: McpServerFeatureEventRegistry;
  private readonly options: NormalizedClientOptions;
  private pendingConnection: ActiveConnection | undefined;
  private recoveryPromise: Promise<ActiveConnection> | undefined;
  private toolDefinitions = new Map<string, ExplicitHttpMcpTool>();
  private connectionGeneration = 0;
  private readonly catalogGenerations = new Map<McpCatalogKind, number>();

  constructor(options: ExplicitHttpMcpClientOptions) {
    this.options = normalizeOptions(options);
    this.featureEvents = new McpServerFeatureEventRegistry(this.options.onServerFeatureEventError);
  }

  async connect(options?: ExplicitHttpMcpRequestOptions): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connect = (operation?: InteractiveOAuthOperation) =>
      this.getConnection(requestOptions, operation);
    await (this.options.interactiveOAuth?.runOperation(connect) ?? connect());
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

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  async listTools(
    options?: ExplicitHttpMcpRequestOptions,
    params?: ExplicitHttpMcpListToolsParams
  ): Promise<ExplicitHttpMcpListToolsResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    let successfulGeneration: number | undefined;
    const result = await this.runRequest((client, connection) => {
      successfulGeneration = connection.generation;
      const catalogOptions = this.resolveCatalogOptions(
        'tools',
        connection,
        params,
        requestOptions
      );
      return client.listTools(params, catalogOptions);
    }, requestOptions);
    if (params?.cursor === undefined) {
      this.catalogGenerations.set('tools', successfulGeneration ?? this.connectionGeneration);
      const nextToolDefinitions = new Map<string, ExplicitHttpMcpTool>();
      for (const tool of result.tools) {
        nextToolDefinitions.set(tool.name, tool);
      }
      this.toolDefinitions = nextToolDefinitions;
      return result;
    }
    for (const tool of result.tools) {
      this.toolDefinitions.set(tool.name, tool);
    }
    return result;
  }

  async listPrompts(
    options?: ExplicitHttpMcpRequestOptions,
    params?: ExplicitHttpMcpListPromptsParams
  ): Promise<ExplicitHttpMcpListPromptsResult> {
    return this.listCatalog('prompts', options, params, (client, requestParams, requestOptions) =>
      client.listPrompts(requestParams, requestOptions)
    );
  }

  async listResources(
    options?: ExplicitHttpMcpRequestOptions,
    params?: ExplicitHttpMcpListResourcesParams
  ): Promise<ExplicitHttpMcpListResourcesResult> {
    return this.listCatalog('resources', options, params, (client, requestParams, requestOptions) =>
      client.listResources(requestParams, requestOptions)
    );
  }

  async listResourceTemplates(
    options?: ExplicitHttpMcpRequestOptions,
    params?: ExplicitHttpMcpListResourceTemplatesParams
  ): Promise<ExplicitHttpMcpListResourceTemplatesResult> {
    return this.listCatalog(
      'resource-templates',
      options,
      params,
      (client, requestParams, requestOptions) =>
        client.listResourceTemplates(requestParams, requestOptions)
    );
  }

  async readResource(
    params: ExplicitHttpMcpReadResourceParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpReadResourceResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest((client) => client.readResource(params, requestOptions), requestOptions);
  }

  async getPrompt(
    params: ExplicitHttpMcpGetPromptParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpGetPromptResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest((client) => client.getPrompt(params, requestOptions), requestOptions);
  }

  async complete(
    params: ExplicitHttpMcpCompleteParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpCompleteResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest((client) => client.complete(params, requestOptions), requestOptions);
  }

  async subscribeResource(
    params: ExplicitHttpMcpReadResourceParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    await this.runRequest(
      (client) => client.subscribeResource(params, requestOptions),
      requestOptions
    );
  }

  async unsubscribeResource(
    params: ExplicitHttpMcpReadResourceParams,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    await this.runRequest(
      (client) => client.unsubscribeResource(params, requestOptions),
      requestOptions
    );
  }

  async listen(
    filter: ExplicitHttpMcpSubscriptionFilter,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<ExplicitHttpMcpSubscription> {
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest((client) => client.listen(filter, requestOptions), requestOptions);
  }

  async requestExtension<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: Params,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<Result> {
    const registry = this.options.extensionRegistry;
    if (registry === undefined) {
      throw new Error(`MCP extension request "${contract.method}" requires an extension registry`);
    }
    if (this.options.transport !== 'streamable-http') {
      throw new Error(
        `MCP extension request "${contract.method}" requires the streamable-http transport`
      );
    }
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest(async (client) => {
      const prepared = await registry.prepareRequest(
        contract,
        params,
        client.getServerCapabilities()?.extensions,
        client.getNegotiatedProtocolVersion()
      );
      return client.request(
        { method: prepared.internalMethod, params: prepared.params },
        prepared.resultSchema,
        requestOptions
      );
    }, requestOptions);
  }

  async listenTasks(
    taskIds: readonly string[],
    handler: McpTasksNotificationHandler,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<McpTasksNotificationLease> {
    if (this.options.transport !== 'streamable-http') {
      throw new Error('MCP Tasks notifications require the streamable-http transport');
    }
    const registry = requireMcpTasksRegistry(this.options.extensionRegistry, 'notifications');
    const requestOptions = normalizeMcpRequestOptions(options);
    return this.runRequest(
      (client) => listenForMcpTasks(client, registry, taskIds, handler, requestOptions),
      requestOptions
    );
  }

  watchServerFeatures(handlers: McpServerFeatureEventHandlers): () => void {
    return this.featureEvents.subscribe(handlers);
  }

  async callTool(
    params: ExplicitHttpMcpCallToolParams,
    options: ExplicitHttpMcpManualCallOptions
  ): Promise<ExplicitHttpMcpCallToolResult | ExplicitHttpMcpInputRequiredResult>;
  async callTool(
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpNormalCallOptions
  ): Promise<ExplicitHttpMcpCallToolResult>;
  async callTool(
    params: ExplicitHttpMcpCallToolParams,
    options?: ExplicitHttpMcpManualCallOptions | ExplicitHttpMcpNormalCallOptions
  ): Promise<ExplicitHttpMcpCallToolResult | ExplicitHttpMcpInputRequiredResult> {
    const normalizedOptions = normalizeMcpRequestOptions(options);
    return this.runRequest((client) => {
      const toolDefinition =
        normalizedOptions.toolDefinition === undefined
          ? this.toolDefinitions.get(params.name)
          : undefined;
      const requestOptions =
        toolDefinition === undefined ? normalizedOptions : { ...normalizedOptions, toolDefinition };
      return client.callTool(params, requestOptions);
    }, normalizedOptions);
  }

  async sendRootsListChanged(options?: ExplicitHttpMcpRequestOptions): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    await this.runRequest((client) => {
      requestOptions.signal?.throwIfAborted();
      return client.sendRootsListChanged();
    }, requestOptions);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.options.interactiveOAuth?.close();
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
    this.toolDefinitions = new Map();

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

  private async getConnection(
    options?: ExplicitHttpMcpRequestOptions,
    operation?: InteractiveOAuthOperation
  ): Promise<ActiveConnection> {
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

    return this.startConnection(options, operation);
  }

  private startConnection(
    options?: ExplicitHttpMcpRequestOptions,
    operation?: InteractiveOAuthOperation
  ): Promise<ActiveConnection> {
    this.connectionGeneration += 1;
    const connection = this.createConnection();
    this.pendingConnection = connection;
    const connectPromise = this.openConnection(connection, options, operation);
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
    options?: ExplicitHttpMcpRequestOptions,
    operation?: InteractiveOAuthOperation
  ): Promise<ActiveConnection> {
    const { client, transport } = connection;
    let connected = false;
    try {
      await client.connect(transport, options);
      await this.options.capabilityRuntime.afterConnect(client, options?.signal);
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
      return this.handleOpenConnectionFailure(connection, options, operation, connected, error);
    }
  }

  private async handleOpenConnectionFailure(
    connection: ActiveConnection,
    options: ExplicitHttpMcpRequestOptions | undefined,
    operation: InteractiveOAuthOperation | undefined,
    connected: boolean,
    error: unknown
  ): Promise<ActiveConnection> {
    if (!connected && this.options.interactiveOAuth) {
      if (!operation) {
        throw new Error('Interactive OAuth connection is missing its operation context');
      }
      if (!(connection.transport instanceof StreamableHTTPClientTransport)) {
        throw new AggregateError(
          [error, new Error('Interactive OAuth requires a Streamable HTTP transport')],
          'MCP connection failed with an invalid interactive OAuth transport'
        );
      }
      return this.options.interactiveOAuth.handleOpeningFailure(
        {
          cleanup: () => this.closeConnection(connection),
          closedError: closedClientError,
          isClosed: () => this.closed,
          primaryError: error,
          reconnect: () => this.startConnection(options, operation),
          ...(options?.signal ? { signal: options.signal } : {}),
          terminalCleanup: () => this.closePromise,
          transport: connection.transport,
        },
        operation
      );
    }
    if (!connected) {
      try {
        await this.closeConnection(connection);
      } catch (cleanupError) {
        const primaryError = options?.signal?.aborted ? options.signal.reason : error;
        throw new AggregateError(
          [primaryError, cleanupError],
          'Opening and cleaning up an MCP HTTP connection both failed'
        );
      }
    }
    options?.signal?.throwIfAborted();
    throw error;
  }

  private closeConnection(connection: ActiveConnection): Promise<void> {
    connection.closePromise ??= this.closeConnectionOnce(connection);
    return connection.closePromise;
  }

  private async closeConnectionOnce(connection: ActiveConnection): Promise<void> {
    await closeOwnedHttpConnection(connection);
  }

  private createConnection(): ActiveConnection {
    const extensions = this.options.extensionRegistry?.toClientExtensionCapabilities();
    const capabilities = {
      ...this.options.capabilityRuntime.capabilities,
      ...(extensions ? { extensions } : {}),
    };
    const clientOptions = {
      capabilities,
      enforceStrictCapabilities: true,
      inputRequired: this.options.inputRequired,
      listMaxPages: this.options.listMaxPages,
      versionNegotiation: toMcpVersionNegotiation(this.options.protocol),
      ...(this.options.cachePartition === undefined
        ? {}
        : { cachePartition: this.options.cachePartition }),
      ...(this.options.defaultCacheTtlMs === undefined
        ? {}
        : { defaultCacheTtlMs: this.options.defaultCacheTtlMs }),
      responseCacheStore: this.options.responseCacheStore,
    } satisfies ClientOptions;
    const client = new Client(this.options.clientInfo, clientOptions);
    const capabilityLease = this.options.capabilityRuntime.install(client, this.options.serverName);
    this.featureEvents.install(client);
    const connection = {
      capabilityLease,
      client,
      disconnected: false,
      generation: this.connectionGeneration,
      transport: this.createTransport(),
    };
    client.onclose = () => this.invalidateConnection(connection);
    return connection;
  }

  private async runRequest<T>(
    request: (client: Client, connection: ActiveConnection) => Promise<T>,
    options?: ExplicitHttpMcpRequestOptions
  ): Promise<T> {
    const run = (operation?: InteractiveOAuthOperation) =>
      this.runRequestWithinAuthorizationOperation(request, options, operation);
    return this.options.interactiveOAuth?.runOperation(run) ?? run();
  }

  private async runRequestWithinAuthorizationOperation<T>(
    request: (client: Client, connection: ActiveConnection) => Promise<T>,
    options?: ExplicitHttpMcpRequestOptions,
    operation?: InteractiveOAuthOperation
  ): Promise<T> {
    const interactiveOAuth = this.options.interactiveOAuth;
    if (interactiveOAuth && !operation) {
      throw new Error('Interactive OAuth request is missing its operation context');
    }
    const connection = await this.getConnection(options, operation);
    while (true) {
      const hadSession =
        connection.transport instanceof StreamableHTTPClientTransport &&
        connection.transport.sessionId !== undefined;
      try {
        return await request(connection.client, connection);
      } catch (error) {
        options?.signal?.throwIfAborted();
        if (this.closed) {
          throw error;
        }
        const authorizationCompleted = await tryCompleteInteractiveOAuthRequestAuthorization({
          cleanup: () => this.closeConnection(connection),
          completion: interactiveOAuth,
          invalidate: () => this.invalidateConnection(connection),
          operation,
          primaryError: error,
          signal: options?.signal,
          transport: connection.transport,
        });
        if (authorizationCompleted) {
          continue;
        }
        return this.handleRequestFailure(
          connection,
          error,
          hadSession,
          options,
          request,
          operation
        );
      }
    }
  }

  private async handleRequestFailure<T>(
    connection: ActiveConnection,
    error: unknown,
    hadSession: boolean,
    options: ExplicitHttpMcpRequestOptions | undefined,
    request: (client: Client, connection: ActiveConnection) => Promise<T>,
    operation?: InteractiveOAuthOperation
  ): Promise<T> {
    if (
      !(
        connection.transport instanceof StreamableHTTPClientTransport &&
        isReconnectableSessionError(error, hadSession)
      )
    ) {
      throw error;
    }
    if (this.options.lifecycle === 'host-owned') {
      if (this.invalidateConnection(connection, true)) {
        await this.closeInvalidatedConnection(connection);
      }
      throw error;
    }
    const recovered = await this.recoverConnection(connection, options, operation);
    options?.signal?.throwIfAborted();
    return request(recovered.client, recovered);
  }

  private async listCatalog<Params extends { cursor?: string | undefined }, Result>(
    kind: Exclude<McpCatalogKind, 'tools'>,
    options: ExplicitHttpMcpRequestOptions | undefined,
    params: Params | undefined,
    request: (
      client: Client,
      params: Params | undefined,
      options: ExplicitHttpMcpListRequestOptions
    ) => Promise<Result>
  ): Promise<Result> {
    const requestOptions = normalizeMcpRequestOptions(options);
    let successfulGeneration: number | undefined;
    const result = await this.runRequest((client, connection) => {
      successfulGeneration = connection.generation;
      return request(
        client,
        params,
        this.resolveCatalogOptions(kind, connection, params, requestOptions)
      );
    }, requestOptions);
    if (params?.cursor === undefined) {
      this.catalogGenerations.set(kind, successfulGeneration ?? this.connectionGeneration);
    }
    return result;
  }

  private resolveCatalogOptions(
    kind: McpCatalogKind,
    connection: ActiveConnection,
    params: { cursor?: string | undefined } | undefined,
    options: ExplicitHttpMcpRequestOptions
  ): ExplicitHttpMcpListRequestOptions {
    if (
      params?.cursor !== undefined ||
      this.catalogGenerations.get(kind) === connection.generation
    ) {
      return options;
    }
    return { ...options, cacheMode: 'refresh' };
  }

  private recoverConnection(
    failedConnection: ActiveConnection,
    options?: ExplicitHttpMcpRequestOptions,
    operation?: InteractiveOAuthOperation
  ): Promise<ActiveConnection> {
    if (this.closed) {
      return Promise.reject(closedClientError());
    }
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    if (this.activeConnection !== failedConnection) {
      return this.getConnection(options, operation);
    }

    this.activeConnection = undefined;
    const recoveryPromise = (async () => {
      await failedConnection.client.close();
      if (this.closed) {
        throw closedClientError();
      }
      options?.signal?.throwIfAborted();
      return this.startConnection(options, operation);
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
    this.connectionGeneration += 1;
    this.toolDefinitions = new Map();
    this.catalogGenerations.clear();
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
    const authProvider = this.options.interactiveOAuth?.authProvider ?? this.options.authProvider;
    switch (this.options.transport) {
      case 'sse':
        return new SSEClientTransport(this.options.url, {
          ...(this.options.authProvider ? { authProvider: this.options.authProvider } : {}),
          fetch: this.options.fetch,
        });
      case 'streamable-http':
        return installRegisteredExtensionDispatch(
          new StreamableHTTPClientTransport(this.options.url, {
            ...(authProvider ? { authProvider } : {}),
            fetch: this.options.fetch,
            ...(this.options.maxStepUpRetries === undefined
              ? {}
              : { maxStepUpRetries: this.options.maxStepUpRetries }),
            ...(this.options.onInsufficientScope === undefined
              ? {}
              : { onInsufficientScope: this.options.onInsufficientScope }),
          }),
          this.options.extensionRegistry
        );
      default:
        return unsupportedTransport(this.options.transport);
    }
  }
}
