import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createMcpElicitationCapability,
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
  ExplicitStdioMcpClient,
  type ExplicitStdioMcpClientOptions,
  type McpClientCapabilityOptions,
  type McpClientExtensionRegistry,
  type NegotiatedProtocolFacts,
} from '@brainstrike/agent/mcp-client';
import {
  type ConfiguredMcpServerId,
  type McpHostAuthSnapshot,
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
  parseMcpHostConfig,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';
import {
  createSecretsMcpBearerCredentialAuthority,
  type McpBearerCredentialAuthority,
} from './bearer-credential';
import { createMcpCoreServerFeatures, type McpCoreFeatureClient } from './core-server-features';
import { McpElicitationPresenterAuthority } from './elicitation-presenter';
import {
  createDefaultMcpExtensionRegistry,
  createDefaultTaskDatabaseOpener,
  requireTaskConnectionClient,
} from './host-extensions';
import { McpHostRevisionPublisher } from './host-revision-publisher';
import { McpHostService } from './host-service';
import { classifyMcpConnectFailure, McpLifecycleFailure } from './lifecycle-errors';
import {
  createLazySafeStorageMcpOAuthStore,
  createMcpOAuthClientProvider,
  createMcpOAuthStoreIdentity,
  type McpOAuthClientProvider,
  type McpOAuthClientProviderOptions,
  type McpOAuthCloseProof,
  type McpOAuthStore,
  readMcpOAuthAuthProjection,
} from './oauth-client-provider';
import { openExternalWithElectron } from './open-external';
import {
  McpServerActor,
  type McpServerActorClient,
  McpServerActorClientCleanupError,
  type McpServerActorClientFactory,
} from './server-actor';
import { McpStdioDiagnosticCollector } from './stdio-diagnostics';
import {
  McpDesktopTaskHost,
  type McpDesktopTaskHostPort,
  type McpTaskConnection,
  type McpTaskConnectionObserver,
} from './task-host';
import { connectedStatus } from './types';

type ActorContext = Parameters<McpServerActorClientFactory>[0];
type ConfiguredServer = McpHostConfig['servers'][number];
const MCP_OAUTH_MAX_STEP_UP_RETRIES = 3;
export interface ExplicitClient extends NegotiatedProtocolFacts {
  callTool: McpCoreFeatureClient['callTool'];
  close: ExplicitHttpMcpClient['close'];
  complete: McpCoreFeatureClient['complete'];
  connect: ExplicitHttpMcpClient['connect'];
  getPrompt: McpCoreFeatureClient['getPrompt'];
  listen: McpCoreFeatureClient['listen'];
  /** Present on both production clients; required whenever an extension registry is attached. */
  listenTasks?: ExplicitHttpMcpClient['listenTasks'];
  listPrompts: McpCoreFeatureClient['listPrompts'];
  listResources: McpCoreFeatureClient['listResources'];
  listResourceTemplates: McpCoreFeatureClient['listResourceTemplates'];
  listTools: McpCoreFeatureClient['listTools'];
  readResource: McpCoreFeatureClient['readResource'];
  requestExtension?: ExplicitHttpMcpClient['requestExtension'];
  subscribeResource: McpCoreFeatureClient['subscribeResource'];
  unsubscribeResource: McpCoreFeatureClient['unsubscribeResource'];
  watchServerFeatures: McpCoreFeatureClient['watchServerFeatures'];
}
export interface DesktopMcpHostRuntimeDependencies {
  bearerCredentialAuthority?: McpBearerCredentialAuthority;
  createActorClient?: (
    server: ResolvedMcpServer,
    context: ActorContext
  ) => ReturnType<McpServerActorClientFactory>;
  createConfigRef?: () => string;
  createHttpTransportClient?: (options: ExplicitHttpMcpClientOptions) => ExplicitClient;
  createOAuthProvider?: (options: McpOAuthClientProviderOptions) => Promise<McpOAuthClientProvider>;
  createStdioTransportClient?: (options: ExplicitStdioMcpClientOptions) => ExplicitClient;
  oauthStore?: McpOAuthStore;
  onInternalError?: (code: string, cause: unknown) => Promise<void> | void;
  openExternal?: (url: string) => Promise<void>;
  resolveClientCapabilities?: (server: ResolvedMcpServer) => McpClientCapabilityOptions | undefined;
  /**
   * Host-owned extension registration (BST-1566). Called once per connection
   * generation and must return a FRESH registry each time: a registry seals on
   * its first projection, so one instance can never serve two connections.
   * `undefined` advertises no extensions. Defaults to
   * `createDefaultMcpExtensionRegistry`.
   */
  resolveExtensionRegistry?: (
    server: ResolvedMcpServer,
    context: ActorContext
  ) => McpClientExtensionRegistry | undefined;
  /** Durable task authorities; defaults to the process-local `McpDesktopTaskHost`. */
  taskHost?: McpDesktopTaskHostPort;
}

function createDefaultBearerCredentialAuthority(): McpBearerCredentialAuthority {
  let authority: Promise<McpBearerCredentialAuthority> | undefined;
  const load = (): Promise<McpBearerCredentialAuthority> => {
    authority ??= import('../secrets').then(({ getSecretsService }) =>
      createSecretsMcpBearerCredentialAuthority(getSecretsService())
    );
    return authority;
  };
  return {
    createFetch(reference, resourceUrl, onStateChanged) {
      return async (input, init) =>
        await (await load()).createFetch(reference, resourceUrl, onStateChanged)(input, init);
    },
    async inspect(reference) {
      return await (await load()).inspect(reference);
    },
  };
}

function createDefaultOAuthStore(): McpOAuthStore {
  return createLazySafeStorageMcpOAuthStore(async () => {
    const { createDefaultSafeStorageMcpOAuthStore } = await import('./oauth-safe-storage-defaults');
    return createDefaultSafeStorageMcpOAuthStore();
  });
}

interface PrivateConfigEntry {
  auth: McpHostAuthSnapshot;
  configRef: string;
  server: ResolvedMcpServer;
}

interface StagedResolvedConfig {
  readonly nextById: Map<ConfiguredMcpServerId, PrivateConfigEntry>;
  readonly nextByRef: Map<string, PrivateConfigEntry>;
  readonly servers: ConfiguredServer[];
}
type ConfigRefErrorCode =
  | 'mcp-config-ref-protocol-mismatch'
  | 'mcp-config-ref-server-mismatch'
  | 'mcp-config-ref-transport-mismatch'
  | 'mcp-config-ref-unknown';
class ConfigRefError extends Error {
  readonly category = 'configuration' as const;
  constructor(readonly code: ConfigRefErrorCode) {
    super('MCP private configuration reference is invalid');
    this.name = 'McpConfigRefError';
  }
}

const logger = createLogger('DesktopMcpHostRuntime');
const samePrivateConfig = (left: ResolvedMcpServer, right: ResolvedMcpServer): boolean =>
  isDeepStrictEqual({ ...left, enabledTools: undefined }, { ...right, enabledTools: undefined });
const successfulCloseReport = (
  transport: ResolvedMcpServer['transport'],
  requestsSettled: number,
  subscriptionsClosed: number,
  oauthProof?: McpOAuthCloseProof
): McpHostCloseReport =>
  Object.freeze({
    callbacksClosed: 1 + (oauthProof?.callbacksClosed ?? 0),
    childProcessesClosed: transport === 'stdio' ? 1 : 0,
    clientsClosed: 1,
    failures: Object.freeze([]),
    loopbackPortsClosed: oauthProof?.loopbackPortsClosed ?? 0,
    probesClosed: 0,
    requestsSettled,
    subscriptionsClosed,
  });

async function closeClientResources(
  client: ExplicitClient,
  provider?: McpOAuthClientProvider
): Promise<McpOAuthCloseProof | undefined> {
  const failures: unknown[] = [];
  let oauthProof: McpOAuthCloseProof | undefined;
  try {
    await client.close();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    oauthProof = await provider?.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'MCP client resources failed to close');
  }
  return oauthProof;
}

async function closeAfterFailure(
  client: ExplicitClient,
  cause: unknown,
  provider?: McpOAuthClientProvider
): Promise<never> {
  try {
    await closeClientResources(client, provider);
  } catch (cleanupCause) {
    throw new McpServerActorClientCleanupError(
      [cause, cleanupCause],
      'MCP client operation failed and cleanup also failed'
    );
  }
  throw cause;
}

async function closeAfterConnectFailure(
  client: ExplicitClient,
  cause: unknown,
  server: ResolvedMcpServer,
  generation: number,
  diagnostics?: McpStdioDiagnosticCollector,
  provider?: McpOAuthClientProvider
): Promise<never> {
  const cleanupFailures: unknown[] = [];
  try {
    await closeClientResources(client, provider);
  } catch (cleanupCause) {
    cleanupFailures.push(cleanupCause);
  } finally {
    // A child can close the protocol stream before Node drains its final
    // stderr chunks. Flush after transport cleanup so both the user-facing
    // classification and durable report use the same complete diagnostics.
    diagnostics?.flush();
    reportStdioFailureDiagnostics(server, generation, diagnostics);
  }
  const failure = classifyMcpConnectFailure(cause, diagnostics?.snapshot(), {
    requiresReauthorization: provider?.requiresReauthorization() === true,
    server: server.name,
  });
  if (cleanupFailures.length > 0) {
    throw new McpServerActorClientCleanupError(
      [failure, ...cleanupFailures],
      'MCP client operation failed and cleanup also failed'
    );
  }
  throw failure;
}

interface TransportActorClient extends McpServerActorClient {
  readonly transportClient: ExplicitClient;
}

async function connectClient(
  client: ExplicitClient,
  server: ResolvedMcpServer,
  context: ActorContext,
  onInternalError: (code: string, cause: unknown) => void,
  extensionRegistry: McpClientExtensionRegistry | undefined,
  diagnostics?: McpStdioDiagnosticCollector,
  provider?: McpOAuthClientProvider,
  onConnected?: () => Promise<void>
): Promise<TransportActorClient> {
  try {
    await client.connect({
      signal: context.signal,
      ...(server.startup === 'automatic' ? { timeout: 10_000 } : {}),
    });
    await onConnected?.();
  } catch (cause) {
    return await closeAfterConnectFailure(
      client,
      cause,
      server,
      context.generation,
      diagnostics,
      provider
    );
  }
  diagnostics?.flush();
  const status = connectedStatus(client, {
    configuredProtocol: server.protocol,
    name: server.name,
    transport: server.transport,
  });
  if (status.state !== 'connected') {
    return await closeAfterFailure(
      client,
      new Error(
        status.state === 'error' ? status.error : 'Connected MCP client has no negotiated status'
      ),
      provider
    );
  }
  const catalogListeners = new Set<(catalog: ReturnType<typeof features.snapshot>) => void>();
  const features = createMcpCoreServerFeatures(client, {
    extensionRegistry,
    onCatalogChanged: (catalog) => {
      for (const listener of catalogListeners) {
        listener(catalog);
      }
    },
    onInternalError,
    signal: context.signal,
  });
  try {
    await features.initialize();
  } catch (cause) {
    return await closeAfterFailure(client, cause, provider);
  }
  let requestsSettled = 0;
  return {
    catalog: () => features.snapshot(),
    async close() {
      try {
        const errors: unknown[] = [];
        let oauthProof: McpOAuthCloseProof | undefined;
        let subscriptionsClosed = 0;
        try {
          subscriptionsClosed = (await features.close()).subscriptionsClosed;
        } catch (cause) {
          errors.push(cause);
        }
        catalogListeners.clear();
        try {
          oauthProof = await closeClientResources(client, provider);
        } catch (cause) {
          errors.push(cause);
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Closing MCP core features and client failed');
        }
        return successfulCloseReport(
          server.transport,
          requestsSettled,
          subscriptionsClosed,
          oauthProof
        );
      } finally {
        diagnostics?.flush();
      }
    },
    async invoke(operation, options) {
      try {
        return await features.invoke(operation, options);
      } finally {
        requestsSettled += 1;
      }
    },
    negotiated: status.negotiated,
    transportClient: client,
    watchCatalog(listener) {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
  };
}

function reportStdioFailureDiagnostics(
  server: ResolvedMcpServer,
  generation: number,
  diagnostics?: McpStdioDiagnosticCollector
): void {
  const report = diagnostics?.takeFailureReport();
  if (!report) {
    return;
  }
  logger.warn('MCP stdio failure diagnostics', {
    diagnostics: report.diagnostics,
    generation,
    omittedDiagnostics: report.omittedDiagnostics,
    server: server.name,
  });
}

export class DesktopMcpHostRuntime {
  private readonly bearerCredentialAuthority: McpBearerCredentialAuthority;
  private committedByRef = new Map<string, PrivateConfigEntry>();
  private currentById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
  private readonly pendingOAuthCleanup = new Map<
    string,
    ReturnType<typeof createMcpOAuthStoreIdentity>
  >();
  readonly host: McpHostPort;
  readonly elicitationPresenter: McpElicitationPresenterAuthority;
  private replacementTail: Promise<void> = Promise.resolve();
  private stagedByRef: Map<string, PrivateConfigEntry> | undefined;
  private readonly createActorClient: NonNullable<
    DesktopMcpHostRuntimeDependencies['createActorClient']
  >;
  private readonly createConfigRef: () => string;
  private readonly createHttpTransportClient: NonNullable<
    DesktopMcpHostRuntimeDependencies['createHttpTransportClient']
  >;
  private readonly createOAuthProvider: NonNullable<
    DesktopMcpHostRuntimeDependencies['createOAuthProvider']
  >;
  private readonly onInternalError: NonNullable<
    DesktopMcpHostRuntimeDependencies['onInternalError']
  >;
  private readonly oauthStore: McpOAuthStore;
  private readonly openExternal: NonNullable<DesktopMcpHostRuntimeDependencies['openExternal']>;
  private readonly resolveClientCapabilities: NonNullable<
    DesktopMcpHostRuntimeDependencies['resolveClientCapabilities']
  >;
  private readonly resolveExtensionRegistry: NonNullable<
    DesktopMcpHostRuntimeDependencies['resolveExtensionRegistry']
  >;
  readonly taskHost: McpDesktopTaskHostPort;
  private readonly service: McpHostService;
  private readonly createStdioTransportClient: NonNullable<
    DesktopMcpHostRuntimeDependencies['createStdioTransportClient']
  >;

  constructor(dependencies: DesktopMcpHostRuntimeDependencies = {}) {
    this.bearerCredentialAuthority =
      dependencies.bearerCredentialAuthority ?? createDefaultBearerCredentialAuthority();
    this.createConfigRef = dependencies.createConfigRef ?? randomUUID;
    this.createHttpTransportClient =
      dependencies.createHttpTransportClient ?? ((options) => new ExplicitHttpMcpClient(options));
    this.createOAuthProvider = dependencies.createOAuthProvider ?? createMcpOAuthClientProvider;
    this.createStdioTransportClient =
      dependencies.createStdioTransportClient ?? ((options) => new ExplicitStdioMcpClient(options));
    this.createActorClient =
      dependencies.createActorClient ??
      ((server, context) => this.createExplicitActorClient(server, context));
    // Production advertises form + URL elicitation backed by the process-local
    // presenter (BST-1584). The arrow reads `this.elicitationPresenter` at call
    // time — after construction below — so every connection shares one authority.
    this.resolveClientCapabilities =
      dependencies.resolveClientCapabilities ??
      (() => ({
        elicitation: createMcpElicitationCapability(this.elicitationPresenter.presenter),
      }));
    this.resolveExtensionRegistry =
      dependencies.resolveExtensionRegistry ??
      ((server) => createDefaultMcpExtensionRegistry(server));
    this.onInternalError =
      dependencies.onInternalError ??
      ((code, cause) => logger.error('MCP host runtime failure', { cause, code }));
    this.oauthStore = dependencies.oauthStore ?? createDefaultOAuthStore();
    this.openExternal = dependencies.openExternal ?? openExternalWithElectron;
    const publisher = new McpHostRevisionPublisher({
      onDiagnostic: ({ code }, cause) => this.reportInternalError(code, cause),
    });
    this.service = new McpHostService({
      actorFactory: (input) => {
        const entry = this.resolveEntry(input.config);
        const server = structuredClone(entry.server);
        let auth = structuredClone(entry.auth);
        const updateAuth = (next: McpHostAuthSnapshot): void => {
          auth = structuredClone(next);
          entry.auth = structuredClone(next);
        };
        return new McpServerActor({
          auth: () => auth,
          ...(input.config.auth.type === 'oauth-user'
            ? { clearCredentials: () => this.clearOAuthCredentials(entry, updateAuth) }
            : {}),
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          ...(input.config.enabledTools ? { enabledTools: input.config.enabledTools } : {}),
          factory: (context) =>
            dependencies.createActorClient
              ? this.createActorClient(server, context)
              : this.createExplicitActorClient(server, context, updateAuth, entry.configRef),
          generation: input.generation,
          onAuthorityRetired: () =>
            this.elicitationPresenter.retireServer(
              input.config.configuredServerId,
              input.generation
            ),
          onInternalError: (code, cause) => this.reportInternalError(code, cause),
          onSnapshotChanged: input.onSnapshotChanged,
          startup: input.config.startup,
          transport: input.config.transport.type,
        });
      },
      onInternalError: (code, cause) => this.reportInternalError(code, cause),
      publisher,
    });
    this.elicitationPresenter = new McpElicitationPresenterAuthority({
      openExternal: async (url) => await this.openExternal(url.href),
      resolveServer: (configuredServerId) =>
        this.service
          .snapshot()
          .servers.find((server) => server.configuredServerId === configuredServerId),
    });
    this.taskHost =
      dependencies.taskHost ??
      new McpDesktopTaskHost({
        elicitationPresenter: this.elicitationPresenter,
        onInternalError: (code, cause) => this.reportInternalError(code, cause),
        openDatabase: createDefaultTaskDatabaseOpener(),
      });
    this.host = {
      close: async () => {
        this.elicitationPresenter.close();
        const report = await this.service.close();
        await this.taskHost.close();
        return report;
      },
      control: (request) =>
        Promise.resolve().then(() => this.service.control(parseMcpHostControlRequest(request))),
      invoke: (operation, options) =>
        Promise.resolve().then(() => {
          const parsed = parseMcpHostOperation(operation);
          return this.elicitationPresenter.runWithOperation(parsed, () =>
            this.service.invoke(parsed, options)
          );
        }),
      replaceConfig: (config) =>
        this.enqueueReplacement(async () => {
          const parsed = parseMcpHostConfig(config);
          return await this.service.replaceConfig(parsed);
        }),
      snapshot: () => this.service.snapshot(),
      watch: (filter, listener) => this.service.watch(filter, listener),
    };
  }

  replaceResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot> {
    const snapshot = structuredClone(config);
    return this.enqueueReplacement(async () => {
      // Preparation (auth projection) can reject; nothing is retired until it
      // succeeds, so a rejected replacement leaves the old actor AND its
      // Tasks session exactly as they were.
      const staged = await this.stageResolvedConfig(snapshot);
      const retirements: Promise<void>[] = [];
      for (const [configuredServerId, current] of this.currentById) {
        const next = snapshot.servers.find(({ name }) => name === configuredServerId);
        if (!(next && isDeepStrictEqual(current.server, next))) {
          this.retirePresentations(configuredServerId);
        }
        // Task authority epochs retire only when the private definition
        // changes or the server disappears; an enabledTools-only reload is a
        // reconnect that rebinds the live epoch. Each server's session is
        // independent, so retirements run concurrently.
        if (!next) {
          retirements.push(this.taskHost.retired(configuredServerId, 'server-removed'));
        } else if (!samePrivateConfig(current.server, next)) {
          retirements.push(this.taskHost.retired(configuredServerId, 'server-replaced'));
        }
      }
      const retirementFailures = (await Promise.allSettled(retirements)).flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (retirementFailures.length > 0) {
        throw new AggregateError(retirementFailures, 'MCP Tasks epoch retirement failed');
      }
      return await this.commitResolvedConfig(staged);
    });
  }

  private retirePresentations(configuredServerId: ConfiguredMcpServerId): void {
    const current = this.service
      .snapshot()
      .servers.find((server) => server.configuredServerId === configuredServerId);
    if (current) {
      this.elicitationPresenter.retireServer(configuredServerId, current.generation);
    }
  }

  retiredCleanupReport(): McpHostCloseReport {
    return this.service.retiredCleanupReport();
  }

  private enqueueReplacement<T>(operation: () => Promise<T>): Promise<T> {
    const replacement = this.replacementTail.then(operation);
    this.replacementTail = replacement.then(
      () => undefined,
      () => undefined
    );
    return replacement;
  }

  /** Projects auth for every server; rejects before any live state changes. */
  private async stageResolvedConfig(config: ResolvedMcpConfig): Promise<StagedResolvedConfig> {
    const nextById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
    const nextByRef = new Map<string, PrivateConfigEntry>();
    const servers = await Promise.all(
      config.servers.map(async (inputServer): Promise<ConfiguredServer> => {
        const server = structuredClone(inputServer);
        const configuredServerId = parseConfiguredMcpServerId(server.name);
        const previous = this.currentById.get(configuredServerId);
        const configRef =
          previous && samePrivateConfig(previous.server, server)
            ? previous.configRef
            : this.createConfigRef();
        const entry = {
          auth: await this.projectAuth(server),
          configRef,
          server,
        } satisfies PrivateConfigEntry;
        nextById.set(configuredServerId, entry);
        nextByRef.set(configRef, entry);
        return {
          auth: 'auth' in server ? (server.auth ?? { type: 'none' }) : { type: 'none' },
          configuredProtocol: server.protocol,
          configuredServerId,
          ...(server.enabledTools ? { enabledTools: server.enabledTools } : {}),
          startup: server.startup,
          transport: { configRef, type: server.transport },
        };
      })
    );
    return { nextById, nextByRef, servers };
  }

  private async commitResolvedConfig({
    nextById,
    nextByRef,
    servers,
  }: StagedResolvedConfig): Promise<McpHostSnapshot> {
    const previousEntries = [...this.currentById.values()];
    this.stagedByRef = nextByRef;
    try {
      const snapshot = await this.service.replaceConfig({ servers });
      this.currentById = nextById;
      this.committedByRef = nextByRef;
      const nextIdentityKeys = new Set(
        [...nextById.values()].flatMap(({ server }) => {
          const identity = this.oauthIdentity(server);
          return identity ? [JSON.stringify(identity)] : [];
        })
      );
      const obsoleteIdentities = previousEntries.flatMap(({ server }) => {
        const identity = this.oauthIdentity(server);
        return identity && !nextIdentityKeys.has(JSON.stringify(identity)) ? [identity] : [];
      });
      for (const key of nextIdentityKeys) {
        this.pendingOAuthCleanup.delete(key);
      }
      for (const identity of obsoleteIdentities) {
        this.pendingOAuthCleanup.set(JSON.stringify(identity), identity);
      }
      const cleanupEntries = [...this.pendingOAuthCleanup.entries()];
      const cleanupResults = await Promise.allSettled(
        cleanupEntries.map(async ([, identity]) => await this.oauthStore.clear(identity))
      );
      const cleanupFailures: unknown[] = [];
      for (const [index, result] of cleanupResults.entries()) {
        if (result.status === 'fulfilled') {
          const key = cleanupEntries[index]?.[0];
          if (key !== undefined) {
            this.pendingOAuthCleanup.delete(key);
          }
        } else {
          cleanupFailures.push(result.reason);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, 'MCP OAuth credential cleanup failed');
      }
      return snapshot;
    } finally {
      this.stagedByRef = undefined;
    }
  }

  private resolveEntry(config: ConfiguredServer): PrivateConfigEntry {
    // A reused ref can differ only by enabledTools, which stays in the public config.
    const entry =
      this.stagedByRef?.get(config.transport.configRef) ??
      this.committedByRef.get(config.transport.configRef);
    if (!entry) {
      throw new ConfigRefError('mcp-config-ref-unknown');
    }
    const { server } = entry;
    if (server.name !== config.configuredServerId) {
      throw new ConfigRefError('mcp-config-ref-server-mismatch');
    }
    if (server.protocol !== config.configuredProtocol) {
      throw new ConfigRefError('mcp-config-ref-protocol-mismatch');
    }
    if (server.transport !== config.transport.type) {
      throw new ConfigRefError('mcp-config-ref-transport-mismatch');
    }
    return entry;
  }

  private reportInternalError(code: string, cause: unknown): void {
    try {
      const pending = this.onInternalError(code, cause);
      if (pending) {
        void pending.catch((diagnosticCause: unknown) => {
          logger.error('MCP host diagnostic sink rejected', { cause: diagnosticCause, code });
        });
      }
    } catch (diagnosticCause) {
      logger.error('MCP host diagnostic sink threw', { cause: diagnosticCause, code });
    }
  }

  private async projectAuth(server: ResolvedMcpServer): Promise<McpHostAuthSnapshot> {
    if (server.transport === 'stdio' || server.auth === undefined || server.auth.type === 'none') {
      return { type: 'none' };
    }
    if (server.auth.type === 'bearer') {
      const { state: credentialState } = await this.bearerCredentialAuthority.inspect(
        server.auth.credential
      );
      return { credentialState, type: 'bearer' };
    }
    const identity = createMcpOAuthStoreIdentity(server.name, server.url, server.auth.scopes);
    try {
      return await readMcpOAuthAuthProjection(this.oauthStore, identity, {
        ...(server.auth.scopes ? { requestedScopes: server.auth.scopes } : {}),
      });
    } catch (cause) {
      this.reportInternalError('mcp-oauth-credential-read-failed', cause);
      return {
        credentialState: 'unreadable',
        grantedScopes: [],
        requestedScopes: [...(server.auth.scopes ?? [])],
        resourceUrl: identity.resourceUrl,
        type: 'oauth-user',
      };
    }
  }

  private oauthIdentity(server: ResolvedMcpServer) {
    return server.transport !== 'stdio' && server.auth?.type === 'oauth-user'
      ? createMcpOAuthStoreIdentity(server.name, server.url, server.auth.scopes)
      : undefined;
  }

  private async createExplicitActorClient(
    server: ResolvedMcpServer,
    context: ActorContext,
    updateAuth: (auth: McpHostAuthSnapshot) => void = () => undefined,
    configRef?: string
  ): Promise<McpServerActorClient> {
    const extensionRegistry = this.resolveExtensionRegistry(server, context);
    const actorClient = await this.createTransportActorClient(
      server,
      context,
      updateAuth,
      extensionRegistry
    );
    if (!extensionRegistry) {
      return actorClient;
    }
    if (configRef === undefined) {
      throw new Error(`MCP server "${server.name}" connected without a private configuration ref.`);
    }
    return await this.bindTaskHost(actorClient, {
      client: requireTaskConnectionClient(actorClient.transportClient, server),
      configRef,
      configuredServerId: context.configuredServerId,
      generation: context.generation,
      registry: extensionRegistry,
      server,
    });
  }

  /**
   * Hands a negotiated connection to the task authorities; the actor client
   * closes the task session before the transport so no poller outlives it.
   */
  private async bindTaskHost(
    actorClient: TransportActorClient,
    connection: McpTaskConnection
  ): Promise<McpServerActorClient> {
    const observer: McpTaskConnectionObserver = this.taskHost;
    try {
      await observer.connected(connection);
    } catch (cause) {
      try {
        await actorClient.close();
      } catch (cleanupCause) {
        throw new McpServerActorClientCleanupError(
          [cause, cleanupCause],
          'MCP Tasks session failed to open and client cleanup also failed'
        );
      }
      throw cause;
    }
    const { transportClient: _transportClient, ...client } = actorClient;
    return {
      ...client,
      async close() {
        const failures: unknown[] = [];
        try {
          await observer.disconnected(connection.configuredServerId, connection.generation);
        } catch (cause) {
          failures.push(cause);
        }
        let report: McpHostCloseReport;
        try {
          report = await actorClient.close();
        } catch (cause) {
          failures.push(cause);
          if (failures.length > 1) {
            throw new AggregateError(failures, 'Closing MCP Tasks session and client failed');
          }
          throw cause;
        }
        if (failures.length > 0) {
          throw failures[0];
        }
        return report;
      },
    };
  }

  private commonClientOptions(
    server: ResolvedMcpServer,
    context: ActorContext,
    extensionRegistry: McpClientExtensionRegistry | undefined
  ) {
    const clientCapabilities = this.resolveClientCapabilities(server);
    return {
      cachePartition: `${server.name}:${context.generation}`,
      clientInfo: { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
      ...(clientCapabilities ? { clientCapabilities } : {}),
      ...(extensionRegistry ? { extensionRegistry } : {}),
      name: server.name,
      protocol: server.protocol,
    };
  }

  private async createTransportActorClient(
    server: ResolvedMcpServer,
    context: ActorContext,
    updateAuth: (auth: McpHostAuthSnapshot) => void,
    extensionRegistry: McpClientExtensionRegistry | undefined
  ): Promise<TransportActorClient> {
    const common = this.commonClientOptions(server, context, extensionRegistry);
    const diagnostics =
      server.transport === 'stdio'
        ? new McpStdioDiagnosticCollector((diagnostic) => {
            context.onDiagnostic(diagnostic);
            logger.debug('MCP stdio diagnostic', {
              diagnostic: diagnostic.message,
              server: server.name,
              truncated: diagnostic.truncated,
            });
          })
        : undefined;
    if (server.transport === 'stdio') {
      const client = this.createStdioTransportClient({
        ...common,
        ...(server.args ? { args: server.args } : {}),
        command: server.command,
        ...(server.env ? { env: server.env } : {}),
        onStderr: (chunk) => diagnostics?.write(chunk),
        onUnexpectedClose: () => {
          reportStdioFailureDiagnostics(server, context.generation, diagnostics);
          context.onUnexpectedClose(new McpLifecycleFailure('connection', 'mcp-child-exited'));
        },
        userPacedAuth: server.startup === 'authentication-required',
      });
      return connectClient(
        client,
        server,
        context,
        (code, cause) => this.reportInternalError(code, cause),
        extensionRegistry,
        diagnostics
      );
    }
    let provider: McpOAuthClientProvider | undefined;
    if (server.auth?.type === 'oauth-user') {
      provider = await this.createOAuthProvider({
        openExternal: this.openExternal,
        ...(server.auth.scopes ? { scopes: server.auth.scopes } : {}),
        serverId: server.name,
        serverUrl: server.url,
        store: this.oauthStore,
      });
      updateAuth(provider.authSnapshot());
    }
    const bearerFetch =
      server.auth?.type === 'bearer'
        ? this.bearerCredentialAuthority.createFetch(
            server.auth.credential,
            server.url,
            (credentialState) => updateAuth({ credentialState, type: 'bearer' })
          )
        : undefined;
    let client: ExplicitClient;
    try {
      client = this.createHttpTransportClient({
        ...common,
        ...(provider
          ? {
              authorizationCallbackSource: provider,
              authProvider: provider,
              fetch: provider.fetch,
              maxStepUpRetries: MCP_OAUTH_MAX_STEP_UP_RETRIES,
            }
          : bearerFetch
            ? { fetch: bearerFetch }
            : {}),
        ...(server.headers ? { headers: server.headers } : {}),
        lifecycle: 'host-owned',
        ...(provider ? { onInsufficientScope: 'reauthorize' as const } : {}),
        onUnexpectedClose: () => context.onUnexpectedClose(),
        transport: server.transport,
        url: server.url,
      });
    } catch (cause) {
      try {
        await provider?.close();
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          'MCP transport construction failed and OAuth cleanup also failed'
        );
      }
      throw cause;
    }
    return connectClient(
      client,
      server,
      context,
      (code, cause) => this.reportInternalError(code, cause),
      extensionRegistry,
      undefined,
      provider,
      provider
        ? async () => {
            try {
              await provider.recordSuccessfulConnection();
              updateAuth(provider.authSnapshot());
            } catch (cause) {
              this.reportInternalError('mcp-oauth-connection-record-failed', cause);
            }
          }
        : undefined
    );
  }

  private async clearOAuthCredentials(
    entry: PrivateConfigEntry,
    updateAuth: (auth: McpHostAuthSnapshot) => void
  ): Promise<void> {
    const { server } = entry;
    if (server.transport === 'stdio' || server.auth?.type !== 'oauth-user') {
      throw new Error('MCP OAuth credential clearing requires an oauth-user HTTP server');
    }
    await this.oauthStore.clear(
      createMcpOAuthStoreIdentity(server.name, server.url, server.auth.scopes)
    );
    updateAuth(await this.projectAuth(server));
  }
}

export const createDesktopMcpHostRuntime = (
  dependencies?: DesktopMcpHostRuntimeDependencies
): DesktopMcpHostRuntime => new DesktopMcpHostRuntime(dependencies);

let singleton: DesktopMcpHostRuntime | undefined;
export const getDesktopMcpHostRuntime = (): DesktopMcpHostRuntime =>
  (singleton ??= createDesktopMcpHostRuntime());
