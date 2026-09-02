import type {
  ExplicitHttpMcpClient,
  ExplicitHttpMcpSubscription,
  McpClientExtensionRegistry,
  McpServerFeatureEventHandlers,
} from '@brainstrike/agent/mcp-client';
import { MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT } from '@brainstrike/agent/mcp-client';
import type {
  McpHostCatalog,
  McpHostCatalogSection,
  McpHostInvokeOptions,
  McpHostOperation,
  McpHostSubscriptionFilter,
} from '@brainstrike/assistant-contract';
import {
  parseMcpHostCatalog,
  parseMcpHostOperationResult,
} from '@brainstrike/assistant-contract/mcp-host-runtime';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

export interface McpCoreFeatureClient {
  callTool(...args: Parameters<ExplicitHttpMcpClient['callTool']>): Promise<unknown>;
  complete(...args: Parameters<ExplicitHttpMcpClient['complete']>): Promise<unknown>;
  getPrompt(...args: Parameters<ExplicitHttpMcpClient['getPrompt']>): Promise<unknown>;
  getProtocolEra(): ReturnType<ExplicitHttpMcpClient['getProtocolEra']>;
  getServerCapabilities(): ReturnType<ExplicitHttpMcpClient['getServerCapabilities']>;
  listen(
    ...args: Parameters<ExplicitHttpMcpClient['listen']>
  ): Promise<ExplicitHttpMcpSubscription>;
  listPrompts(...args: Parameters<ExplicitHttpMcpClient['listPrompts']>): Promise<unknown>;
  listResources(...args: Parameters<ExplicitHttpMcpClient['listResources']>): Promise<unknown>;
  listResourceTemplates(
    ...args: Parameters<ExplicitHttpMcpClient['listResourceTemplates']>
  ): Promise<unknown>;
  listTools(...args: Parameters<ExplicitHttpMcpClient['listTools']>): Promise<unknown>;
  readResource(...args: Parameters<ExplicitHttpMcpClient['readResource']>): Promise<unknown>;
  /** Registered-extension dispatch; required when `extensionRegistry` registers Tasks. */
  requestExtension?: ExplicitHttpMcpClient['requestExtension'];
  subscribeResource(...args: Parameters<ExplicitHttpMcpClient['subscribeResource']>): Promise<void>;
  unsubscribeResource(
    ...args: Parameters<ExplicitHttpMcpClient['unsubscribeResource']>
  ): Promise<void>;
  watchServerFeatures: ExplicitHttpMcpClient['watchServerFeatures'];
}

type Backoff = (attempt: number, signal: AbortSignal) => Promise<void>;
/** SDK request options for one `tools/call`, shared by the core and Tasks dispatch paths. */
type ToolCallRequestOptions = NonNullable<Parameters<ExplicitHttpMcpClient['callTool']>[1]>;
type CatalogListOperation = Extract<
  McpHostOperation,
  {
    type: 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'tools/list';
  }
>;
interface McpCoreServerFeaturesOptions {
  backoff?: Backoff;
  /**
   * The connection's sealed extension registry (BST-1566). When it registers
   * MCP Tasks and the server advertises the extension, `tools/call` dispatches
   * through the registered task-result contract: on the pinned 2026-07-28
   * client a core `callTool` answer with `resultType: 'task'` is rejected by
   * the SDK funnel, so a task can only arrive on the registered path.
   */
  extensionRegistry?: McpClientExtensionRegistry | undefined;
  onCatalogChanged?: ((catalog: McpHostCatalog) => void) | undefined;
  onInternalError?: ((code: string, cause: unknown) => void) | undefined;
  signal?: AbortSignal | undefined;
}
interface CloseProof {
  callbacksClosed: number;
  subscriptionsClosed: number;
}

const MAX_RELISTEN_ATTEMPTS = 3;
const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

function serverAdvertisesTasks(client: McpCoreFeatureClient): boolean {
  const capabilities = client.getServerCapabilities();
  const extensions = isRecord(capabilities) ? capabilities['extensions'] : undefined;
  return isRecord(extensions) && Object.hasOwn(extensions, MCP_TASKS_EXTENSION_ID);
}
const RELISTEN_DELAYS_MS = [100, 250, 500] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function advertisedFeatures(client: McpCoreFeatureClient): McpHostCatalog['features'] {
  const capabilities = client.getServerCapabilities();
  const root = isRecord(capabilities) ? capabilities : {};
  const tools = isRecord(root['tools']) ? root['tools'] : undefined;
  const resources = isRecord(root['resources']) ? root['resources'] : undefined;
  const prompts = isRecord(root['prompts']) ? root['prompts'] : undefined;
  return {
    completion: isRecord(root['completions']),
    promptListChanged: prompts?.['listChanged'] === true,
    prompts: prompts !== undefined,
    resourceListChanged: resources?.['listChanged'] === true,
    resourceSubscriptions: resources?.['subscribe'] === true,
    resources: resources !== undefined,
    toolListChanged: tools?.['listChanged'] === true,
    tools: tools !== undefined,
  };
}

function safeCatalogError(section: McpHostCatalogSection): {
  category: 'operation';
  code: string;
  message: string;
} {
  return {
    category: 'operation',
    code: `mcp-${section.replace(/[A-Z]/gu, (character: string) => `-${character.toLowerCase()}`)}-failed`,
    message: 'MCP catalog operation failed',
  };
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unhandled MCP host operation: ${String(operation)}`);
}

function isCatalogListOperation(operation: McpHostOperation): operation is CatalogListOperation {
  return (
    operation.type === 'prompts/list' ||
    operation.type === 'resources/list' ||
    operation.type === 'resources/templates/list' ||
    operation.type === 'tools/list'
  );
}

function defaultBackoff(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const delayMs = RELISTEN_DELAYS_MS.at(Math.min(attempt - 1, RELISTEN_DELAYS_MS.length - 1));
  if (delayMs === undefined) {
    return Promise.reject(new Error('MCP subscription backoff schedule is empty'));
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function listParams(operation: {
  _meta?: Record<string, unknown> | undefined;
  cursor?: string | undefined;
}) {
  return operation._meta !== undefined || operation.cursor !== undefined
    ? {
        ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
        ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
      }
    : undefined;
}

function requestOptions(options: McpHostInvokeOptions, signal: AbortSignal) {
  return { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal };
}

export class McpCoreServerFeatures {
  private readonly abort = new AbortController();
  private catalog: McpHostCatalog;
  private closePromise: Promise<CloseProof> | undefined;
  private currentSubscription: ExplicitHttpMcpSubscription | undefined;
  private readonly extensionRegistry: McpClientExtensionRegistry | undefined;
  private initialized = false;
  private listenTail: Promise<void> = Promise.resolve();
  private readonly onCatalogChanged: (catalog: McpHostCatalog) => void;
  private readonly onInternalError: (code: string, cause: unknown) => void;
  private readonly backoff: Backoff;
  private readonly resourceSubscriptions = new Set<string>();
  private relistenAttempts = 0;
  private readonly signal: AbortSignal;
  private subscriptionClosures = 0;
  private unsubscribeEvents: (() => void) | undefined;

  constructor(
    private readonly client: McpCoreFeatureClient,
    options: McpCoreServerFeaturesOptions = {}
  ) {
    this.backoff = options.backoff ?? defaultBackoff;
    this.extensionRegistry = options.extensionRegistry;
    this.onCatalogChanged = options.onCatalogChanged ?? (() => undefined);
    this.onInternalError = options.onInternalError ?? (() => undefined);
    this.signal = options.signal
      ? AbortSignal.any([this.abort.signal, options.signal])
      : this.abort.signal;
    const features = advertisedFeatures(client);
    const era = client.getProtocolEra();
    this.catalog = parseMcpHostCatalog({
      errors: {},
      features,
      subscription:
        era === 'legacy'
          ? {
              mode:
                features.promptListChanged ||
                features.resourceListChanged ||
                features.resourceSubscriptions ||
                features.toolListChanged
                  ? 'legacy-unsolicited'
                  : 'none',
              state:
                features.promptListChanged ||
                features.resourceListChanged ||
                features.resourceSubscriptions ||
                features.toolListChanged
                  ? 'listening'
                  : 'unsupported',
            }
          : { mode: 'modern-listen', state: 'closed' },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const handlers: McpServerFeatureEventHandlers = {
      onPromptListChanged: async () => await this.refreshPrompts(),
      onResourceListChanged: async () => {
        await Promise.all([this.refreshResources(), this.refreshResourceTemplates()]);
      },
      onResourceUpdated: () => undefined,
      onToolListChanged: async () => await this.refreshTools(),
    };
    this.unsubscribeEvents = this.client.watchServerFeatures(handlers);
    const refreshes: Promise<void>[] = [];
    if (this.catalog.features.tools) {
      refreshes.push(this.refreshTools());
    }
    if (this.catalog.features.resources) {
      refreshes.push(this.refreshResources(), this.refreshResourceTemplates());
    }
    if (this.catalog.features.prompts) {
      refreshes.push(this.refreshPrompts());
    }
    await Promise.all(refreshes);
    if (this.client.getProtocolEra() === 'modern') {
      await this.enqueueListen(async () => {
        await this.openModernSubscription();
      });
    }
  }

  snapshot(): McpHostCatalog {
    return parseMcpHostCatalog(structuredClone(this.catalog));
  }

  private tasksRegistered(): boolean {
    return (
      this.extensionRegistry?.toClientExtensionCapabilities()?.[MCP_TASKS_EXTENSION_ID] !==
      undefined
    );
  }

  private invokeToolCall(
    operation: Extract<McpHostOperation, { type: 'tools/call' }>,
    options: McpHostInvokeOptions,
    normalizedOptions: ReturnType<typeof requestOptions>
  ): Promise<unknown> {
    // Both dispatch paths carry the same request options: progress reaches
    // the caller's writer and resets the request timeout whichever path the
    // server's advertisement selects.
    const callOptions: ToolCallRequestOptions = {
      ...(options.onProgress === undefined ? {} : { onprogress: options.onProgress }),
      resetTimeoutOnProgress: true,
      ...normalizedOptions,
    };
    if (this.tasksRegistered() && serverAdvertisesTasks(this.client)) {
      return this.callToolThroughTasks(operation, callOptions);
    }
    return this.client.callTool(
      {
        ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
        ...(operation.arguments === undefined ? {} : { arguments: operation.arguments }),
        name: operation.toolName,
        ...(operation.task === undefined ? {} : { task: operation.task }),
      },
      callOptions
    );
  }

  private callToolThroughTasks(
    operation: Extract<McpHostOperation, { type: 'tools/call' }>,
    callOptions: ToolCallRequestOptions
  ): Promise<unknown> {
    const { requestExtension } = this.client;
    if (typeof requestExtension !== 'function') {
      throw new Error(
        `MCP tool "${operation.toolName}" needs registered-extension dispatch but the client has none.`
      );
    }
    if (operation._meta !== undefined || operation.task !== undefined) {
      throw new Error(
        `MCP tool "${operation.toolName}" cannot carry _meta or task on the MCP Tasks call path.`
      );
    }
    return requestExtension.call(
      this.client,
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      {
        ...(operation.arguments === undefined ? {} : { arguments: operation.arguments }),
        name: operation.toolName,
      },
      callOptions
    );
  }

  async invoke(operation: McpHostOperation, options: McpHostInvokeOptions): Promise<unknown> {
    const normalizedOptions = requestOptions(options, this.signal);
    if (isCatalogListOperation(operation)) {
      return this.invokeCatalogList(operation, normalizedOptions);
    }
    switch (operation.type) {
      case 'tools/call':
        return this.invokeToolCall(operation, options, normalizedOptions);
      case 'resources/read':
        return this.client.readResource(
          {
            ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
            uri: operation.uri,
          },
          normalizedOptions
        );
      case 'prompts/get':
        return this.client.getPrompt(
          {
            ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
            ...(operation.arguments === undefined ? {} : { arguments: operation.arguments }),
            name: operation.name,
          },
          normalizedOptions
        );
      case 'completion/complete':
        return this.client.complete(
          {
            ...(operation._meta === undefined ? {} : { _meta: operation._meta }),
            argument: operation.argument,
            ...(operation.context === undefined ? {} : { context: operation.context }),
            ref: operation.ref,
          },
          normalizedOptions
        );
      case 'resources/subscribe':
        return this.subscribeResource(operation.uri, normalizedOptions);
      case 'resources/unsubscribe':
        return this.unsubscribeResource(operation.uri, normalizedOptions);
      default:
        return assertNeverOperation(operation);
    }
  }

  private async invokeCatalogList(
    operation: CatalogListOperation,
    options: { signal: AbortSignal }
  ): Promise<unknown> {
    let result: unknown;
    switch (operation.type) {
      case 'tools/list':
        result = await this.client.listTools(options, listParams(operation));
        break;
      case 'resources/list':
        result = await this.client.listResources(options, listParams(operation));
        break;
      case 'resources/templates/list':
        result = await this.client.listResourceTemplates(options, listParams(operation));
        break;
      case 'prompts/list':
        result = await this.client.listPrompts(options, listParams(operation));
        break;
      default:
        return assertNeverOperation(operation);
    }
    if (operation.cursor === undefined) {
      this.acceptCatalogResult(operation.type, result);
    }
    return result;
  }

  close(): Promise<CloseProof> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private async closeOwnedResources(): Promise<CloseProof> {
    this.abort.abort(new Error('MCP core server features closed'));
    const unsubscribe = this.unsubscribeEvents;
    this.unsubscribeEvents = undefined;
    unsubscribe?.();
    const subscription = this.currentSubscription;
    this.currentSubscription = undefined;
    if (subscription) {
      await subscription.close();
      this.subscriptionClosures += 1;
    }
    await this.listenTail.catch(() => undefined);
    return {
      callbacksClosed: unsubscribe ? 1 : 0,
      subscriptionsClosed: this.subscriptionClosures,
    };
  }

  private async refreshTools(): Promise<void> {
    try {
      this.acceptCatalogResult('tools/list', await this.client.listTools({ signal: this.signal }));
    } catch (cause) {
      this.recordCatalogError('tools', cause);
    }
  }

  private async refreshResources(): Promise<void> {
    try {
      this.acceptCatalogResult(
        'resources/list',
        await this.client.listResources({ signal: this.signal })
      );
    } catch (cause) {
      this.recordCatalogError('resources', cause);
    }
  }

  private async refreshResourceTemplates(): Promise<void> {
    try {
      this.acceptCatalogResult(
        'resources/templates/list',
        await this.client.listResourceTemplates({ signal: this.signal })
      );
    } catch (cause) {
      this.recordCatalogError('resourceTemplates', cause);
    }
  }

  private async refreshPrompts(): Promise<void> {
    try {
      this.acceptCatalogResult(
        'prompts/list',
        await this.client.listPrompts({ signal: this.signal })
      );
    } catch (cause) {
      this.recordCatalogError('prompts', cause);
    }
  }

  private acceptCatalogResult(
    type: 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'tools/list',
    result: unknown
  ): void {
    const parsed = parseMcpHostOperationResult({ result, type });
    if (parsed.type === 'tools/list') {
      const { tools: _resolved, ...errors } = this.catalog.errors;
      this.catalog = { ...this.catalog, errors, tools: parsed.result };
    } else if (parsed.type === 'resources/list') {
      const { resources: _resolved, ...errors } = this.catalog.errors;
      this.catalog = { ...this.catalog, errors, resources: parsed.result };
    } else if (parsed.type === 'resources/templates/list') {
      const { resourceTemplates: _resolved, ...errors } = this.catalog.errors;
      this.catalog = { ...this.catalog, errors, resourceTemplates: parsed.result };
    } else if (parsed.type === 'prompts/list') {
      const { prompts: _resolved, ...errors } = this.catalog.errors;
      this.catalog = { ...this.catalog, errors, prompts: parsed.result };
    }
    this.publish();
  }

  private recordCatalogError(section: McpHostCatalogSection, cause?: unknown): void {
    if (cause !== undefined) {
      this.diagnose(safeCatalogError(section).code, cause);
    }
    const errors = { ...this.catalog.errors, [section]: safeCatalogError(section) };
    if (section === 'tools') {
      const { tools: _removed, ...catalog } = this.catalog;
      this.catalog = { ...catalog, errors };
    } else if (section === 'resources') {
      const { resources: _removed, ...catalog } = this.catalog;
      this.catalog = { ...catalog, errors };
    } else if (section === 'resourceTemplates') {
      const { resourceTemplates: _removed, ...catalog } = this.catalog;
      this.catalog = { ...catalog, errors };
    } else if (section === 'prompts') {
      const { prompts: _removed, ...catalog } = this.catalog;
      this.catalog = { ...catalog, errors };
    } else {
      this.catalog = { ...this.catalog, errors };
    }
    this.publish();
  }

  private modernFilter(
    resourceSubscriptions: ReadonlySet<string> = this.resourceSubscriptions
  ): McpHostSubscriptionFilter {
    return {
      ...(this.catalog.features.toolListChanged ? { toolsListChanged: true } : {}),
      ...(this.catalog.features.promptListChanged ? { promptsListChanged: true } : {}),
      ...(this.catalog.features.resourceListChanged ? { resourcesListChanged: true } : {}),
      ...(resourceSubscriptions.size > 0
        ? { resourceSubscriptions: [...resourceSubscriptions].sort() }
        : {}),
    };
  }

  private async openModernSubscription(): Promise<boolean> {
    if (this.signal.aborted) {
      return false;
    }
    try {
      const subscription = await this.createModernSubscription(
        this.resourceSubscriptions,
        this.signal
      );
      if (this.signal.aborted) {
        await this.closeUncommittedSubscription(subscription, this.signal.reason);
        return false;
      }
      this.currentSubscription = subscription;
      this.relistenAttempts = 0;
      this.publishModernSubscription(subscription);
      this.watchSubscription(subscription);
      return true;
    } catch (cause) {
      if (this.signal.aborted) {
        return false;
      }
      this.recordCatalogError('subscription', cause);
      this.catalog = {
        ...this.catalog,
        subscription: { mode: 'modern-listen', state: 'closed' },
      };
      this.publish();
      return false;
    }
  }

  private async createModernSubscription(
    resourceSubscriptions: ReadonlySet<string>,
    signal: AbortSignal
  ): Promise<ExplicitHttpMcpSubscription | undefined> {
    signal.throwIfAborted();
    const filter = this.modernFilter(resourceSubscriptions);
    if (Object.keys(filter).length === 0) {
      return undefined;
    }
    const { resourceSubscriptions: subscriptions, ...baseFilter } = filter;
    return this.client.listen(
      {
        ...baseFilter,
        ...(subscriptions ? { resourceSubscriptions: [...subscriptions] } : {}),
      },
      { signal }
    );
  }

  private publishModernSubscription(subscription?: ExplicitHttpMcpSubscription): void {
    const { subscription: _resolved, ...errors } = this.catalog.errors;
    this.catalog = {
      ...this.catalog,
      errors,
      subscription: subscription
        ? {
            honoredFilter: subscription.honoredFilter,
            mode: 'modern-listen',
            state: 'listening',
          }
        : { mode: 'modern-listen', state: 'closed' },
    };
    this.publish();
  }

  private watchSubscription(subscription?: ExplicitHttpMcpSubscription): void {
    if (!subscription) {
      return;
    }
    void subscription.closed.then((reason) => this.handleSubscriptionClosed(subscription, reason));
  }

  private handleSubscriptionClosed(
    subscription: ExplicitHttpMcpSubscription,
    reason: 'graceful' | 'local' | 'remote'
  ): void {
    if (this.currentSubscription !== subscription) {
      return;
    }
    this.currentSubscription = undefined;
    if (reason !== 'remote' || this.signal.aborted) {
      this.catalog = {
        ...this.catalog,
        subscription: { mode: 'modern-listen', state: 'closed' },
      };
      this.publish();
      return;
    }
    void this.enqueueListen(async () => await this.relistenAfterRemoteClose());
  }

  private async relistenAfterRemoteClose(): Promise<void> {
    if (this.signal.aborted) {
      return;
    }
    if (this.relistenAttempts >= MAX_RELISTEN_ATTEMPTS) {
      return;
    }
    this.relistenAttempts += 1;
    const attempt = this.relistenAttempts;
    this.catalog = {
      ...this.catalog,
      subscription: { mode: 'modern-listen', state: 'retrying' },
    };
    this.publish();
    try {
      await this.backoff(attempt, this.signal);
      if (await this.openModernSubscription()) {
        return;
      }
    } catch (cause) {
      if (this.signal.aborted) {
        return;
      }
      this.recordCatalogError('subscription', cause);
    }
    await this.relistenAfterRemoteClose();
  }

  private enqueueListen(operation: () => Promise<void>): Promise<void> {
    const queued = this.listenTail.then(operation);
    this.listenTail = queued.catch(() => undefined);
    return queued;
  }

  private async replaceModernResourceSubscriptions(
    nextResourceSubscriptions: ReadonlySet<string>,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    let candidate: ExplicitHttpMcpSubscription | undefined;
    try {
      candidate = await this.createModernSubscription(nextResourceSubscriptions, signal);
      signal.throwIfAborted();
    } catch (cause) {
      if (candidate) {
        await this.closeUncommittedSubscription(candidate, cause);
      }
      if (!signal.aborted) {
        this.recordCatalogError('subscription', cause);
      }
      throw cause;
    }

    const previous = this.currentSubscription;
    this.currentSubscription = candidate;
    this.resourceSubscriptions.clear();
    for (const uri of nextResourceSubscriptions) {
      this.resourceSubscriptions.add(uri);
    }
    this.relistenAttempts = 0;
    this.publishModernSubscription(candidate);
    this.watchSubscription(candidate);
    if (previous) {
      try {
        await previous.close();
        this.subscriptionClosures += 1;
      } catch (cause) {
        this.recordCatalogError('subscription', cause);
        throw cause;
      }
    }
  }

  private async closeUncommittedSubscription(
    subscription: ExplicitHttpMcpSubscription | undefined,
    cause: unknown
  ): Promise<void> {
    if (!subscription) {
      return;
    }
    try {
      await subscription.close();
      this.subscriptionClosures += 1;
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        'MCP subscription cancellation and cleanup both failed'
      );
    }
  }

  private async subscribeResource(
    uri: string,
    options: { signal: AbortSignal }
  ): Promise<Record<string, never>> {
    if (!this.catalog.features.resourceSubscriptions) {
      throw new SdkError(
        SdkErrorCode.CapabilityNotSupported,
        'Server does not support resource subscriptions'
      );
    }
    if (this.client.getProtocolEra() === 'legacy') {
      await this.client.subscribeResource({ uri }, options);
      return {};
    }
    await this.enqueueListen(async () => {
      options.signal.throwIfAborted();
      if (this.resourceSubscriptions.has(uri)) {
        return;
      }
      const next = new Set(this.resourceSubscriptions);
      next.add(uri);
      await this.replaceModernResourceSubscriptions(next, options.signal);
    });
    return {};
  }

  private async unsubscribeResource(
    uri: string,
    options: { signal: AbortSignal }
  ): Promise<Record<string, never>> {
    if (!this.catalog.features.resourceSubscriptions) {
      throw new SdkError(
        SdkErrorCode.CapabilityNotSupported,
        'Server does not support resource subscriptions'
      );
    }
    if (this.client.getProtocolEra() === 'legacy') {
      await this.client.unsubscribeResource({ uri }, options);
      return {};
    }
    await this.enqueueListen(async () => {
      options.signal.throwIfAborted();
      if (!this.resourceSubscriptions.has(uri)) {
        return;
      }
      const next = new Set(this.resourceSubscriptions);
      next.delete(uri);
      await this.replaceModernResourceSubscriptions(next, options.signal);
    });
    return {};
  }

  private publish(): void {
    this.catalog = parseMcpHostCatalog(structuredClone(this.catalog));
    this.onCatalogChanged(this.snapshot());
  }

  private diagnose(code: string, cause: unknown): void {
    try {
      this.onInternalError(code, cause);
    } catch {}
  }
}

export function createMcpCoreServerFeatures(
  client: McpCoreFeatureClient,
  options?: McpCoreServerFeaturesOptions
): McpCoreServerFeatures {
  return new McpCoreServerFeatures(client, options);
}
