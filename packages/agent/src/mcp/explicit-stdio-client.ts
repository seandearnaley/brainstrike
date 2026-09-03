import type { Client, ClientOptions, JSONObject } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
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
import type { McpProtocol } from './config';
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
  NegotiatedProtocolFacts,
} from './explicit-http-client';
import {
  createExplicitMcpSdkClient,
  type McpCatalogKind,
  type McpClientInfo,
  resolveMcpClientInfo,
  validateNonEmptyMcpOption,
} from './explicit-mcp-client-core';
import {
  installRegisteredExtensionDispatch,
  RegisteredExtensionDispatchLedger,
} from './registered-extension-dispatch';
import { installMcpResultTypeCompatibility } from './result-type-compatibility';
import {
  type McpServerFeatureEventDiagnosticSink,
  type McpServerFeatureEventHandlers,
  McpServerFeatureEventRegistry,
  resolveMcpServerFeatureEventDiagnosticSink,
} from './server-feature-events';
import { installMcpStdioSendClosure } from './stdio-send-closure';
import {
  listenForMcpTasks,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
  requireMcpTasksRegistry,
} from './tasks-extension';
import { notifyUnexpectedClose } from './unexpected-close-observer';

const CLOSED_ERROR_MESSAGE = 'Explicit stdio MCP client is closed';
const DISCONNECTED_DURING_CONNECT_ERROR_MESSAGE =
  'MCP stdio connection closed during initialization';
const SEVERED_SEND_ERROR_MESSAGE = 'MCP stdio child pipe closed before the message was written';
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
export type ExplicitStdioMcpListResourcesParams = ExplicitHttpMcpListResourcesParams;
export type ExplicitStdioMcpListResourcesResult = ExplicitHttpMcpListResourcesResult;
export type ExplicitStdioMcpListResourceTemplatesParams =
  ExplicitHttpMcpListResourceTemplatesParams;
export type ExplicitStdioMcpListResourceTemplatesResult =
  ExplicitHttpMcpListResourceTemplatesResult;
export type ExplicitStdioMcpReadResourceParams = ExplicitHttpMcpReadResourceParams;
export type ExplicitStdioMcpReadResourceResult = ExplicitHttpMcpReadResourceResult;
export type ExplicitStdioMcpListPromptsParams = ExplicitHttpMcpListPromptsParams;
export type ExplicitStdioMcpListPromptsResult = ExplicitHttpMcpListPromptsResult;
export type ExplicitStdioMcpGetPromptParams = ExplicitHttpMcpGetPromptParams;
export type ExplicitStdioMcpGetPromptResult = ExplicitHttpMcpGetPromptResult;
export type ExplicitStdioMcpCompleteParams = ExplicitHttpMcpCompleteParams;
export type ExplicitStdioMcpCompleteResult = ExplicitHttpMcpCompleteResult;
export type ExplicitStdioMcpSubscription = ExplicitHttpMcpSubscription;
export type ExplicitStdioMcpSubscriptionFilter = ExplicitHttpMcpSubscriptionFilter;

export interface ExplicitStdioMcpClientOptions {
  args?: readonly string[];
  cachePartition?: ClientOptions['cachePartition'];
  clientCapabilities?: McpClientCapabilityOptions;
  clientInfo?: McpClientInfo;
  command: string;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  env?: Readonly<Record<string, string>>;
  extensionRegistry?: McpClientExtensionRegistry;
  inputRequired?: ClientOptions['inputRequired'];
  listMaxPages?: ClientOptions['listMaxPages'];
  name: string;
  onServerFeatureEventError?: McpServerFeatureEventDiagnosticSink;
  onStderr?: (chunk: string) => void;
  onUnexpectedClose?: () => void;
  protocol?: McpProtocol;
  responseCacheStore?: ClientOptions['responseCacheStore'];
  userPacedAuth?: boolean;
}

interface ActiveConnection {
  capabilityLease: McpClientCapabilityLease;
  catalogRefreshes: Set<McpCatalogKind>;
  client: Client;
  disconnected: boolean;
  extensionDispatchLedger: RegisteredExtensionDispatchLedger;
  /** Rejects in-flight writes that the dead child's pipe can never drain. */
  failInFlightSends(cause: Error): void;
  removeStderrListener(): void;
  toolDefinitions: ReadonlyMap<string, ExplicitHttpMcpTool>;
  toolMetadataReady: boolean;
  toolMetadataRequest: Promise<ExplicitStdioMcpListToolsResult> | undefined;
  transport: StdioClientTransport;
}

interface NormalizedClientOptions {
  args?: string[];
  cachePartition?: ClientOptions['cachePartition'];
  capabilityRuntime: McpClientCapabilityRuntime;
  clientInfo: McpClientInfo;
  command: string;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  env?: Record<string, string>;
  extensionRegistry?: McpClientExtensionRegistry;
  inputRequired: NonNullable<ClientOptions['inputRequired']>;
  listMaxPages: number;
  onServerFeatureEventError: McpServerFeatureEventDiagnosticSink;
  onStderr?: (chunk: string) => void;
  onUnexpectedClose?: () => void;
  protocol: McpProtocol;
  responseCacheStore: NonNullable<ClientOptions['responseCacheStore']>;
  serverName: string;
  userPacedAuth: boolean;
}

function closedClientError(): Error {
  return new Error(CLOSED_ERROR_MESSAGE);
}

function normalizeOptions(options: ExplicitStdioMcpClientOptions): NormalizedClientOptions {
  const name = validateNonEmptyMcpOption(options.name, 'MCP client name');
  const clientInfo = resolveMcpClientInfo(name, options.clientInfo);
  const protocol = options.protocol ?? 'legacy';
  if (options.userPacedAuth && protocol !== 'legacy') {
    throw new Error('MCP user-paced stdio authorization requires legacy protocol policy');
  }

  const cachePartition = normalizeMcpCachePartition(
    options.cachePartition,
    options.responseCacheStore !== undefined
  );
  const capabilityConfiguration = composeMcpTransportCapabilities({
    ...(options.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {}),
    ...(options.inputRequired ? { inputRequired: options.inputRequired } : {}),
  });
  return {
    capabilityRuntime: capabilityConfiguration.runtime,
    clientInfo,
    ...(cachePartition === undefined ? {} : { cachePartition }),
    command: validateNonEmptyMcpOption(options.command, 'MCP stdio command'),
    ...(options.defaultCacheTtlMs === undefined
      ? {}
      : { defaultCacheTtlMs: options.defaultCacheTtlMs }),
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    inputRequired: capabilityConfiguration.inputRequired,
    listMaxPages: normalizeMcpListMaxPages(options.listMaxPages),
    onServerFeatureEventError: resolveMcpServerFeatureEventDiagnosticSink(
      options.onServerFeatureEventError,
      name
    ),
    ...(options.onUnexpectedClose ? { onUnexpectedClose: options.onUnexpectedClose } : {}),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    protocol,
    responseCacheStore: createMcpResponseCacheStore(options.responseCacheStore),
    serverName: name,
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
  private readonly featureEvents: McpServerFeatureEventRegistry;
  private readonly options: NormalizedClientOptions;
  private pendingConnection: ActiveConnection | undefined;

  constructor(options: ExplicitStdioMcpClientOptions) {
    this.options = normalizeOptions(options);
    this.featureEvents = new McpServerFeatureEventRegistry(this.options.onServerFeatureEventError);
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
    const result = await connection.client.listTools(
      params,
      this.resolveCatalogOptions(connection, 'tools', params, requestOptions)
    );
    if (params.cursor === undefined) {
      connection.catalogRefreshes.add('tools');
      this.replaceToolMetadata(connection, result);
    }
    return result;
  }

  async listPrompts(
    options?: ExplicitStdioMcpRequestOptions,
    params?: ExplicitHttpMcpListPromptsParams
  ): Promise<ExplicitHttpMcpListPromptsResult> {
    return this.listCatalog('prompts', options, params, (client, requestParams, requestOptions) =>
      client.listPrompts(requestParams, requestOptions)
    );
  }

  async listResources(
    options?: ExplicitStdioMcpRequestOptions,
    params?: ExplicitHttpMcpListResourcesParams
  ): Promise<ExplicitHttpMcpListResourcesResult> {
    return this.listCatalog('resources', options, params, (client, requestParams, requestOptions) =>
      client.listResources(requestParams, requestOptions)
    );
  }

  async listResourceTemplates(
    options?: ExplicitStdioMcpRequestOptions,
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

  async sendRootsListChanged(options?: ExplicitStdioMcpRequestOptions): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    requestOptions.signal?.throwIfAborted();
    await connection.client.sendRootsListChanged();
  }

  async readResource(
    params: ExplicitStdioMcpReadResourceParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpReadResourceResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    return connection.client.readResource(params, requestOptions);
  }

  async getPrompt(
    params: ExplicitStdioMcpGetPromptParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpGetPromptResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    return connection.client.getPrompt(params, requestOptions);
  }

  async complete(
    params: ExplicitStdioMcpCompleteParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpCompleteResult> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    return connection.client.complete(params, requestOptions);
  }

  async subscribeResource(
    params: ExplicitStdioMcpReadResourceParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    await connection.client.subscribeResource(params, requestOptions);
  }

  async unsubscribeResource(
    params: ExplicitStdioMcpReadResourceParams,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<void> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    await connection.client.unsubscribeResource(params, requestOptions);
  }

  async listen(
    filter: ExplicitStdioMcpSubscriptionFilter,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpSubscription> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    return connection.client.listen(filter, requestOptions);
  }

  async requestExtension<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: Params,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<Result> {
    const registry = this.options.extensionRegistry;
    if (registry === undefined) {
      throw new Error(`MCP extension request "${contract.method}" requires an extension registry`);
    }
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    const prepared = await registry.prepareRequest(
      contract,
      params,
      connection.client.getServerCapabilities()?.extensions,
      connection.client.getNegotiatedProtocolVersion()
    );
    return connection.client.request(
      { method: prepared.internalMethod, params: prepared.params },
      prepared.resultSchema,
      requestOptions
    );
  }

  async listenTasks(
    taskIds: readonly string[],
    handler: McpTasksNotificationHandler,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<McpTasksNotificationLease> {
    const registry = requireMcpTasksRegistry(this.options.extensionRegistry, 'notifications');
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    return listenForMcpTasks(
      connection.client,
      registry,
      connection.extensionDispatchLedger,
      taskIds,
      handler,
      requestOptions
    );
  }

  watchServerFeatures(handlers: McpServerFeatureEventHandlers): () => void {
    return this.featureEvents.subscribe(handlers);
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
      [...connections].map((connection) => this.closeConnection(connection))
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
      await this.options.capabilityRuntime.afterConnect(connection.client, options?.signal);
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
        try {
          await this.closeConnection(connection);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Opening and cleaning up an MCP stdio connection both failed'
          );
        }
      }
      throw error;
    }
  }

  private async closeConnection(connection: ActiveConnection): Promise<void> {
    const results = await Promise.allSettled([
      connection.capabilityLease.close(),
      connection.transport.close(),
      connection.client.close(),
    ]);
    // Only AFTER teardown. Severing first would poison this connection's own
    // farewell traffic — the SDK answers a capability request the lease aborts
    // through the transport it captured at request time — and would attribute a
    // still-live child's ordinary backpressure to a dead pipe. By this point
    // `transport.close()` has ended the parent's write end (and killed the
    // child if it did not exit), so any write still waiting on `'drain'` truly
    // can never be written and the cause below reads accurately. Teardown never
    // awaits a send, so nothing here can deadlock behind the move.
    connection.failInFlightSends(new Error(SEVERED_SEND_ERROR_MESSAGE));
    connection.removeStderrListener();
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Closing one MCP stdio connection failed');
    }
  }

  private createConnection(): ActiveConnection {
    const { capabilityLease, client } = createExplicitMcpSdkClient(
      this.options,
      this.featureEvents
    );
    const extensionDispatchLedger = new RegisteredExtensionDispatchLedger();
    const stdioTransport = new StdioClientTransport({
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.onStderr ? { stderr: 'pipe' as const } : {}),
    });
    // Installed on the raw transport, before the extension/result wrappers, so
    // every message this connection writes is covered by the closure.
    const sendClosure = installMcpStdioSendClosure(stdioTransport);
    const transport = installMcpResultTypeCompatibility(
      installRegisteredExtensionDispatch(
        stdioTransport,
        this.options.extensionRegistry,
        extensionDispatchLedger
      ),
      this.options.protocol,
      () => client.getProtocolEra()
    );
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
      capabilityLease,
      catalogRefreshes: new Set(),
      client,
      disconnected: false,
      extensionDispatchLedger,
      failInFlightSends: (cause) => sendClosure.close(cause),
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
    // First, and before the `disconnected` short-circuit: the SDK's stdio
    // `send()` never settles once the child's pipe is gone, and `listen()`
    // awaits it before it can handle its own closure rejection (BST-1600).
    connection.failInFlightSends(new Error(SEVERED_SEND_ERROR_MESSAGE));
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

  private async listCatalog<Params extends { cursor?: string | undefined }, Result>(
    kind: Exclude<McpCatalogKind, 'tools'>,
    options: ExplicitStdioMcpRequestOptions | undefined,
    params: Params | undefined,
    request: (
      client: Client,
      params: Params | undefined,
      options: NonNullable<Parameters<Client['listTools']>[1]>
    ) => Promise<Result>
  ): Promise<Result> {
    const requestOptions = normalizeMcpRequestOptions(options);
    const connection = await this.getConnection(requestOptions);
    const result = await request(
      connection.client,
      params,
      this.resolveCatalogOptions(connection, kind, params, requestOptions)
    );
    if (params?.cursor === undefined) {
      connection.catalogRefreshes.add(kind);
    }
    return result;
  }

  private resolveCatalogOptions(
    connection: ActiveConnection,
    kind: McpCatalogKind,
    params: { cursor?: string | undefined } | undefined,
    options: ExplicitStdioMcpRequestOptions | undefined
  ): NonNullable<Parameters<Client['listTools']>[1]> {
    if (params?.cursor !== undefined || connection.catalogRefreshes.has(kind)) {
      return options ?? {};
    }
    return { ...(options ?? {}), cacheMode: 'refresh' };
  }

  private refreshToolMetadata(
    connection: ActiveConnection,
    options?: ExplicitStdioMcpRequestOptions
  ): Promise<ExplicitStdioMcpListToolsResult> {
    if (connection.toolMetadataRequest) {
      return connection.toolMetadataRequest;
    }
    const request = connection.client.listTools(
      undefined,
      this.resolveCatalogOptions(connection, 'tools', undefined, options)
    );
    const metadataRequest = request.then((result) => {
      connection.catalogRefreshes.add('tools');
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
