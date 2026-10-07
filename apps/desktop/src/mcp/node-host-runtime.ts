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
} from '@brainstrike/agent/mcp-client';
import { type McpToolAuthority, McpToolAuthoritySchema } from '@brainstrike/agent-host/protocol';
import {
  type ConfiguredMcpServerId,
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  type McpHostAuthSnapshot,
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
  parseMcpExtensionEnablement,
  parseMcpHostConfig,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import { applyMcpExtensionPreferences } from '@brainstrike/assistant-contract/mcp-config';
import type { McpTaskDatabase } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';
import type { McpBearerCredentialAuthority } from './bearer-credential';
import { McpElicitationPresenterAuthority } from './elicitation-presenter';
import {
  connectClient,
  type ExplicitClient,
  reportStdioFailureDiagnostics,
  type TransportActorClient,
} from './host-connection';
import {
  createDefaultMcpExtensionRegistry,
  requireTaskConnectionClient,
  resolveMcpServerExtensions,
} from './host-extensions';
import { McpHostRevisionPublisher } from './host-revision-publisher';
import { McpHostService } from './host-service';
import { McpLifecycleFailure } from './lifecycle-errors';
import {
  createMcpOAuthClientProvider,
  createMcpOAuthStoreIdentity,
  type McpOAuthClientProvider,
  type McpOAuthClientProviderOptions,
  type McpOAuthStore,
  readMcpOAuthAuthProjection,
} from './oauth-client-provider';
import {
  McpServerActor,
  type McpServerActorClient,
  McpServerActorClientCleanupError,
  type McpServerActorClientFactory,
} from './server-actor';
import { McpStdioDiagnosticCollector } from './stdio-diagnostics';
import {
  MCP_TASKS_EXTENSION_ID,
  McpDesktopTaskHost,
  type McpDesktopTaskHostPort,
  type McpTaskConnection,
  type McpTaskConnectionObserver,
} from './task-host';

export type { ExplicitClient } from './host-connection';

type ActorContext = Parameters<McpServerActorClientFactory>[0];
type ConfiguredServer = McpHostConfig['servers'][number];
const MCP_OAUTH_MAX_STEP_UP_RETRIES = 3;
type UnavailableAuthorityReason = Extract<McpToolAuthority, { kind: 'unavailable' }>['reason'];
function unavailableAuthority(reason: UnavailableAuthorityReason): McpToolAuthority {
  return Object.freeze({ kind: 'unavailable', reason, version: 1 });
}
function authorityBase(server: ResolvedMcpServer) {
  return {
    extensions: resolveMcpServerExtensions(server),
    protocol: server.protocol ?? (server.transport === 'sse' ? 'legacy' : 'auto'),
    version: 1,
  };
}
function captureHttpToolAuthority(
  server: Exclude<ResolvedMcpServer, { transport: 'stdio' }>
): McpToolAuthority {
  const destination = new URL(server.url);
  if (destination.username || destination.password || destination.search || destination.hash) {
    return unavailableAuthority('private-http-destination');
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    return unavailableAuthority('private-http-headers');
  }
  // The OAuth account identifies resource/scopes, not a stable user principal.
  if (server.auth?.type === 'oauth-user') {
    return unavailableAuthority('oauth-principal-not-comparable');
  }
  return McpToolAuthoritySchema.parse({
    ...authorityBase(server),
    auth:
      server.auth?.type === 'bearer'
        ? { ...server.auth, principalComparison: 'unavailable' }
        : { type: 'none' },
    destination: destination.href,
    kind: 'http',
    transport: server.transport,
  });
}
function captureStdioToolAuthority(
  server: Extract<ResolvedMcpServer, { transport: 'stdio' }>
): McpToolAuthority {
  // No existing non-secret declaration covers private arguments or environment.
  // Keep the live capability, never copy or hash these fields for restart.
  if (server.args?.length) {
    return unavailableAuthority('private-stdio-arguments');
  }
  if (server.env && Object.keys(server.env).length > 0) {
    return unavailableAuthority('private-stdio-environment');
  }
  return McpToolAuthoritySchema.parse({
    ...authorityBase(server),
    args: [],
    command: server.command,
    cwd: process.cwd(),
    kind: 'stdio',
  });
}
function captureConfiguredToolAuthority(server: ResolvedMcpServer): McpToolAuthority {
  const authority =
    server.transport === 'stdio'
      ? captureStdioToolAuthority(server)
      : captureHttpToolAuthority(server);
  if (authority.kind === 'stdio') {
    Object.freeze(authority.args);
  }
  if (authority.kind === 'http') {
    if (authority.auth.type === 'bearer') {
      Object.freeze(authority.auth.credential);
    }
    Object.freeze(authority.auth);
  }
  if (authority.kind !== 'unavailable') {
    Object.freeze(authority.extensions);
  }
  return Object.freeze(authority);
}
/** Platform-owned construction; the configured-server authority owns no desktop defaults. */
export interface McpHostRuntimePlatform {
  /** Rich Apps is a client capability; text-only hosts never advertise the UI extension. */
  readonly appUi: 'rich' | 'text';
  readonly bearerCredentialAuthority: McpBearerCredentialAuthority;
  readonly oauthStore: McpOAuthStore;
  readonly openExternal: (url: string) => Promise<void>;
  /** Reuse the platform's existing database and durable Tasks authority. */
  readonly openTaskDatabase: () => Promise<McpTaskDatabase>;
}

export interface McpHostRuntimeDependencies {
  clientName?: string;
  createActorClient?: (
    server: ResolvedMcpServer,
    context: ActorContext
  ) => ReturnType<McpServerActorClientFactory>;
  createConfigRef?: () => string;
  createHttpTransportClient?: (options: ExplicitHttpMcpClientOptions) => ExplicitClient;
  createOAuthProvider?: (options: McpOAuthClientProviderOptions) => Promise<McpOAuthClientProvider>;
  createStdioTransportClient?: (options: ExplicitStdioMcpClientOptions) => ExplicitClient;
  onInternalError?: (code: string, cause: unknown) => Promise<void> | void;
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

const logger = createLogger('McpHostRuntime');
const samePrivateConfig = (left: ResolvedMcpServer, right: ResolvedMcpServer): boolean =>
  isDeepStrictEqual({ ...left, enabledTools: undefined }, { ...right, enabledTools: undefined });

export class McpHostRuntime {
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
  /** Global registered-extension dials (BST-1604); both start enabled. */
  private extensionPreferences: McpExtensionEnablement = MCP_EXTENSIONS_ENABLED;
  /** Last configuration COMMITTED here, before the global dials are folded in. */
  private declaredConfig: ResolvedMcpConfig = { servers: [] };
  private readonly createActorClient: NonNullable<McpHostRuntimeDependencies['createActorClient']>;
  private readonly createConfigRef: () => string;
  private readonly createHttpTransportClient: NonNullable<
    McpHostRuntimeDependencies['createHttpTransportClient']
  >;
  private readonly createOAuthProvider: NonNullable<
    McpHostRuntimeDependencies['createOAuthProvider']
  >;
  private readonly onInternalError: NonNullable<McpHostRuntimeDependencies['onInternalError']>;
  private readonly oauthStore: McpOAuthStore;
  private readonly openExternal: McpHostRuntimePlatform['openExternal'];
  private readonly clientName: string;
  private readonly resolveClientCapabilities: NonNullable<
    McpHostRuntimeDependencies['resolveClientCapabilities']
  >;
  private readonly resolveExtensionRegistry: NonNullable<
    McpHostRuntimeDependencies['resolveExtensionRegistry']
  >;
  readonly taskHost: McpDesktopTaskHostPort;
  private readonly service: McpHostService;
  private readonly createStdioTransportClient: NonNullable<
    McpHostRuntimeDependencies['createStdioTransportClient']
  >;

  constructor(
    private readonly platform: McpHostRuntimePlatform,
    dependencies: McpHostRuntimeDependencies = {}
  ) {
    this.bearerCredentialAuthority = platform.bearerCredentialAuthority;
    this.clientName = dependencies.clientName ?? 'brainstrike-host';
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
    this.oauthStore = platform.oauthStore;
    this.openExternal = platform.openExternal;
    const publisher = new McpHostRevisionPublisher({
      onDiagnostic: ({ code }, cause) => this.reportInternalError(code, cause),
    });
    this.service = new McpHostService({
      actorFactory: (input) => {
        const entry = this.resolveEntry(input.config);
        const server = structuredClone(entry.server);
        let auth = structuredClone(entry.auth);
        let authAttempt = Symbol('mcp-auth-publication');
        const updateAuth = (next: McpHostAuthSnapshot): void => {
          auth = structuredClone(next);
          entry.auth = structuredClone(next);
        };
        return new McpServerActor({
          auth: () => auth,
          ...(input.config.auth.type === 'oauth-user'
            ? {
                clearCredentials: () => {
                  authAttempt = Symbol('mcp-auth-cleared');
                  return this.clearOAuthCredentials(entry, updateAuth);
                },
              }
            : {}),
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          ...(input.config.enabledTools ? { enabledTools: input.config.enabledTools } : {}),
          ...(input.config.extensions ? { extensions: input.config.extensions } : {}),
          factory: (context) => {
            const attempt = Symbol('mcp-auth-attempt');
            authAttempt = attempt;
            // Cancel permits an immediate retry before old cleanup drains. Only
            // the latest attempt owns auth publication; late facts cannot replace
            // the new provider's credentials or an explicit credential clear.
            const publishAuth = (next: McpHostAuthSnapshot): void => {
              if (authAttempt !== attempt) {
                return;
              }
              updateAuth(next);
            };
            return dependencies.createActorClient
              ? this.createActorClient(server, context)
              : this.createExplicitActorClient(server, context, publishAuth, entry.configRef);
          },
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
        openDatabase: platform.openTaskDatabase,
      });
    this.host = {
      close: async () => {
        this.elicitationPresenter.close();
        const report = await this.service.close();
        const settled = await Promise.allSettled([
          this.taskHost.close(),
          this.oauthStore.join?.() ?? Promise.resolve(),
        ]);
        const failures = settled.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'MCP task or credential cleanup failed.');
        }
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
    return this.enqueueReplacement(() =>
      this.applyConfiguration(snapshot, this.extensionPreferences)
    );
  }

  /** Existing configured definition, without a private-value hash or replacement ID. */
  describeToolAuthority(
    configuredServerId: ConfiguredMcpServerId,
    generation: number
  ): McpToolAuthority {
    const live = this.service
      .snapshot()
      .servers.find((server) => server.configuredServerId === configuredServerId);
    const entry = this.currentById.get(configuredServerId);
    if (!entry || live?.generation !== generation || live.state !== 'connected') {
      throw new Error('MCP configured authority is no longer admitted');
    }
    return captureConfiguredToolAuthority(entry.server);
  }

  /** Effective global dials the next connection generation would advertise. */
  get mcpExtensionPreferences(): McpExtensionEnablement {
    return this.extensionPreferences;
  }

  /**
   * Global extension off switch (BST-1604). The dials are folded into every
   * server's private definition, so a flipped dial changes each affected
   * server's config ref and the replacement runs the ordinary
   * server-definition path: the Tasks epoch is retired as `server-replaced`
   * and the connection generation advances. Servers whose effective state is
   * unchanged keep their ref, their generation, and their live epoch.
   */
  setMcpExtensionPreferences(preferences: McpExtensionEnablement): Promise<McpHostSnapshot> {
    // Parsed inside the queued replacement (like `replaceConfig`): a malformed
    // preference rejects that replacement and leaves the live dials alone.
    return this.enqueueReplacement(
      async () =>
        await this.applyConfiguration(this.declaredConfig, parseMcpExtensionEnablement(preferences))
    );
  }

  private async applyConfiguration(
    declared: ResolvedMcpConfig,
    preferences: McpExtensionEnablement
  ): Promise<McpHostSnapshot> {
    const snapshot = applyMcpExtensionPreferences(declared, {
      apps: preferences.apps && this.platform.appUi === 'rich',
      tasks: preferences.tasks,
    });
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
    const committed = await this.commitResolvedConfig(staged);
    this.declaredConfig = declared;
    this.extensionPreferences = preferences;
    return committed;
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
          // The EFFECTIVE state this generation advertises, transport rule
          // included — never the compiled-in default (BST-1604).
          extensions: resolveMcpServerExtensions(server),
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
    // A registry that carries Apps but not Tasks opens no task session: the
    // task host requires the Tasks contracts to be registered and would throw.
    // With Tasks off the connection behaves exactly like one to a server that
    // never advertised it — `track()` still fails loudly at the tool path.
    if (!extensionRegistry?.toClientExtensionCapabilities()?.[MCP_TASKS_EXTENSION_ID]) {
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
      clientInfo: { name: `${this.clientName}-${server.name}`, version: '0.1.0' },
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
        allowInteractiveAuthorization: context.interactiveAuthorization === true,
        openExternal: this.openExternal,
        ...(server.auth.scopes ? { scopes: server.auth.scopes } : {}),
        serverId: server.name,
        serverUrl: server.url,
        signal: context.signal,
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
    try {
      return await connectClient(
        client,
        server,
        context,
        (code, cause) => this.reportInternalError(code, cause),
        extensionRegistry,
        undefined,
        provider,
        provider ? () => this.recordOAuthConnection(provider, updateAuth) : undefined
      );
    } finally {
      // SDK refresh failure may invalidate persisted tokens before authorization.
      // Publish that state before the actor publishes its terminal snapshot.
      this.publishOAuthSnapshot(provider, updateAuth);
    }
  }

  private publishOAuthSnapshot(
    provider: McpOAuthClientProvider | undefined,
    publish: (auth: McpHostAuthSnapshot) => void
  ): void {
    if (!provider) {
      return;
    }
    publish(provider.authSnapshot());
  }

  private async recordOAuthConnection(
    provider: McpOAuthClientProvider,
    updateAuth: (auth: McpHostAuthSnapshot) => void
  ): Promise<void> {
    try {
      await provider.recordSuccessfulConnection();
      updateAuth(provider.authSnapshot());
    } catch (cause) {
      this.reportInternalError('mcp-oauth-connection-record-failed', cause);
    }
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

export const createMcpHostRuntime = (
  platform: McpHostRuntimePlatform,
  dependencies?: McpHostRuntimeDependencies
): McpHostRuntime => new McpHostRuntime(platform, dependencies);
