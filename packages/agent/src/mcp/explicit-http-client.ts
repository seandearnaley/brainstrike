import {
  type Client,
  type JSONObject,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpClientCapabilityLease } from './client-capabilities';
import type { McpClientExtensionRequestContract } from './client-extension-registry';
import { normalizeMcpRequestOptions } from './client-policy';
import {
  type ExplicitHttpMcpClientOptions,
  type NormalizedHttpClientOptions,
  normalizeExplicitHttpClientOptions,
} from './explicit-http-client-options';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpCompleteParams,
  ExplicitHttpMcpCompleteResult,
  ExplicitHttpMcpGetPromptParams,
  ExplicitHttpMcpGetPromptResult,
  ExplicitHttpMcpInputRequiredResult,
  ExplicitHttpMcpListPromptsParams,
  ExplicitHttpMcpListPromptsResult,
  ExplicitHttpMcpListRequestOptions,
  ExplicitHttpMcpListResourcesParams,
  ExplicitHttpMcpListResourcesResult,
  ExplicitHttpMcpListResourceTemplatesParams,
  ExplicitHttpMcpListResourceTemplatesResult,
  ExplicitHttpMcpListToolsParams,
  ExplicitHttpMcpListToolsResult,
  ExplicitHttpMcpManualCallOptions,
  ExplicitHttpMcpNormalCallOptions,
  ExplicitHttpMcpReadResourceParams,
  ExplicitHttpMcpReadResourceResult,
  ExplicitHttpMcpRequestOptions,
  ExplicitHttpMcpSubscription,
  ExplicitHttpMcpSubscriptionFilter,
  ExplicitHttpMcpTool,
  NegotiatedProtocolFacts,
} from './explicit-http-client-types';
import { createExplicitHttpTransport, type ExplicitHttpTransport } from './explicit-http-transport';
import { createExplicitMcpSdkClient, type McpCatalogKind } from './explicit-mcp-client-core';
import { closeOwnedHttpConnection } from './http-connection-cleanup';
import {
  type InteractiveOAuthOperation,
  tryCompleteInteractiveOAuthRequestAuthorization,
} from './interactive-oauth-completion';
import {
  type McpServerFeatureEventHandlers,
  McpServerFeatureEventRegistry,
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

export type { ExplicitHttpMcpClientOptions } from './explicit-http-client-options';
// Named rather than `export *`: this keeps the package surface exactly what
// this module exported before the split. The types module additionally
// declares list/manual/normal call-option aliases that were module-private
// here, and they stay internal.
export type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpCompleteParams,
  ExplicitHttpMcpCompleteResult,
  ExplicitHttpMcpFetch,
  ExplicitHttpMcpGetPromptParams,
  ExplicitHttpMcpGetPromptResult,
  ExplicitHttpMcpInputRequiredResult,
  ExplicitHttpMcpLifecycle,
  ExplicitHttpMcpListPromptsParams,
  ExplicitHttpMcpListPromptsResult,
  ExplicitHttpMcpListResourcesParams,
  ExplicitHttpMcpListResourcesResult,
  ExplicitHttpMcpListResourceTemplatesParams,
  ExplicitHttpMcpListResourceTemplatesResult,
  ExplicitHttpMcpListToolsParams,
  ExplicitHttpMcpListToolsResult,
  ExplicitHttpMcpReadResourceParams,
  ExplicitHttpMcpReadResourceResult,
  ExplicitHttpMcpRequestOptions,
  ExplicitHttpMcpSubscription,
  ExplicitHttpMcpSubscriptionFilter,
  ExplicitHttpMcpTool,
  ExplicitHttpMcpTransport,
  ExplicitHttpMcpUnexpectedCloseObserver,
  NegotiatedProtocolFacts,
} from './explicit-http-client-types';

const CLOSED_ERROR_MESSAGE = 'Explicit HTTP MCP client is closed';

interface ActiveConnection {
  capabilityLease: McpClientCapabilityLease;
  client: Client;
  closePromise?: Promise<void>;
  disconnected: boolean;
  generation: number;
  transport: ExplicitHttpTransport;
}

function closedClientError(): Error {
  return new Error(CLOSED_ERROR_MESSAGE);
}

function isReconnectableSessionError(error: unknown, hadSession: boolean): boolean {
  return hadSession && error instanceof SdkHttpError && error.status === 404;
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
  private readonly options: NormalizedHttpClientOptions;
  private pendingConnection: ActiveConnection | undefined;
  private recoveryPromise: Promise<ActiveConnection> | undefined;
  private toolDefinitions = new Map<string, ExplicitHttpMcpTool>();
  private connectionGeneration = 0;
  private readonly catalogGenerations = new Map<McpCatalogKind, number>();

  constructor(options: ExplicitHttpMcpClientOptions) {
    this.options = normalizeExplicitHttpClientOptions(options);
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
    const ledger = this.options.extensionDispatchLedger;
    return this.runRequest(
      (client) => listenForMcpTasks(client, registry, ledger, taskIds, handler, requestOptions),
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
    const { capabilityLease, client } = createExplicitMcpSdkClient(
      this.options,
      this.featureEvents
    );
    const connection = {
      capabilityLease,
      client,
      disconnected: false,
      generation: this.connectionGeneration,
      transport: createExplicitHttpTransport(this.options, client),
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
}
